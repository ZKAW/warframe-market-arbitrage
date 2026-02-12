import json
import asyncio
import httpx
import uvicorn

from fastapi import FastAPI
from datetime import datetime, timezone
from contextlib import asynccontextmanager

API_BASE = "https://api.warframe.market/v2"

app = FastAPI()

arbitrage_data = {}
shutdown_event = asyncio.Event()
http_client: httpx.AsyncClient | None = None

def read_config():
    if not hasattr(read_config, "_config_data"):
        with open('config.json') as f:
            read_config._config_data = json.load(f)
    return read_config._config_data

def safe_get_keys(data, *keys, default=None):
    try:
        for key in keys:
            data = data[key]
        return data
    except (KeyError, IndexError, TypeError):
        return default

async def safe_get_request(url, params=None, retries=5):
    config = read_config()
    delay = config.get('REQUEST_DELAY', 0.35)
    rl_delay = config.get('RATE_LIMIT_DELAY', 10)

    headers = {
        "Language": "en",
        "Platform": "pc",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
    }

    for attempt in range(retries + 1):
        try:
            if http_client is None: return None
            response = await http_client.get(url, params=params, headers=headers)

            if response.status_code == 200:
                await asyncio.sleep(delay)
                return response

            if response.status_code == 404:
                return None

            if response.status_code == 429:
                print(f"Rate limited (429). Waiting {rl_delay}s...")
                await asyncio.sleep(rl_delay)
                continue

        except httpx.RequestError as e:
            print(f"Request error: {e}")
            await asyncio.sleep(2)

    return None

async def fetch_all_items():
    response = await safe_get_request(f"{API_BASE}/items")
    if response is None:
        return None
    return safe_get_keys(response.json(), 'data')

async def fetch_price_data(item_slug):
    """
    Fetches orders and filters for 'sell', 'visible', and 'ingame'.
    V2 structure: uses 'type' instead of 'order_type'.
    """
    response = await safe_get_request(f"{API_BASE}/orders/item/{item_slug}")
    if response is None:
        return None

    orders = safe_get_keys(response.json(), 'data', default=[])

    valid_prices = [
        order['platinum']
        for order in orders
        if order.get('type') == 'sell'
        and order.get('visible') is True
        and safe_get_keys(order, 'user', 'status') == 'ingame'
    ]

    return min(valid_prices) if valid_prices else None

async def get_item_details(item_slug):
    response = await safe_get_request(f"{API_BASE}/item/{item_slug}")
    if response is None:
        return None
    return safe_get_keys(response.json(), 'data')

async def get_item_specs(item_slug):
    response = await get_item_details(item_slug)
    if response is None:
        return None
    # return slug and quantity in set
    quantity = safe_get_keys(response, 'quantityInSet', default=1)
    slug = safe_get_keys(response, 'slug')

    return {"slug": slug, "quantity": quantity}

async def get_components(manifest):
    set_parts = safe_get_keys(manifest, 'setParts', default=[])
    components = []
    for uid in set_parts:
        specs = await get_item_specs(uid)
        if not specs:
            break
        components.append(specs)
    return components

async def process_single_set(set_slug):
    config = read_config()

    response = await safe_get_request(f"{API_BASE}/items/{set_slug}")
    if not response:
        return

    manifest = response.json().get('data', {})
    components = await get_components(manifest)

    if not components:
        return

    set_price = None
    total_parts_cost = 0

    for item in components:
        slug = item["slug"]
        quantity = item.get("quantity", 1)

        if slug == set_slug:
            set_price = await fetch_price_data(slug)
        else:
            price = await fetch_price_data(slug)
            if price is None:
                return
            total_parts_cost += price * quantity

    if not set_price:
        return

    arbitrage_value = set_price - total_parts_cost

    if arbitrage_value >= config.get('MIN_ARBITRAGE_VALUE', 10):
        arbitrage_data[set_slug] = {
            'set': set_slug,
            'arbitrage_value': arbitrage_value,
            'set_price': set_price,
            'total_part_price': total_parts_cost,
            'market_url': f'https://warframe.market/items/{set_slug}',
            'last_updated': datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
        }
        print(f"Profit Found: {set_slug} (+{arbitrage_value}p)")

async def fetch_and_update_arbitrage_data():
    config = read_config()
    while not shutdown_event.is_set():
        try:
            print(f"Cycle started: {datetime.now().strftime('%H:%M:%S')}")
            items = await fetch_all_items()
            print(f"Fetched {len(items) if items else 0} items")
            if items:
                sets = [i for i in items if i['slug'].endswith('_set')]
                for set_item in sets:
                    if shutdown_event.is_set(): break
                    await process_single_set(set_item['slug'])

            print("Cycle complete. Waiting for next interval...")
        except Exception as e:
            print(f"Loop error: {e}")

        for _ in range(int(config.get('RETRY_INTERVAL', 600))):
            if shutdown_event.is_set(): break
            await asyncio.sleep(1)

@app.get("/")
@app.post("/")
async def get_arbitrage_opportunities():
    return sorted(
        arbitrage_data.values(),
        key=lambda x: x['arbitrage_value'],
        reverse=True
    )

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(timeout=30.0)
    background_task = asyncio.create_task(fetch_and_update_arbitrage_data())
    yield
    shutdown_event.set()
    background_task.cancel()
    try:
        await background_task
    except asyncio.CancelledError:
        pass
    await http_client.aclose()

app.router.lifespan_context = lifespan

if __name__ == "__main__":
    config = read_config()
    port = int(config.get('PORT', 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)