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
    """
    Returns the full list of component specs for a set, or None if ANY
    component lookup fails. Previously this returned a partial list on
    failure, which let arbitrage be computed off incomplete part data
    (silently undercounting total_parts_cost -> false positives).
    """
    set_parts = safe_get_keys(manifest, 'setParts', default=[])
    components = []
    for uid in set_parts:
        specs = await get_item_specs(uid)
        if not specs:
            return None
        components.append(specs)
    return components

async def process_single_set(set_slug):
    """
    Refreshes a single set's arbitrage entry. Crucially, this function is
    now responsible for REMOVING the entry from arbitrage_data whenever the
    set no longer qualifies (missing data, no live sell orders, or
    arbitrage value has dropped below threshold) rather than leaving stale
    data behind.
    """
    config = read_config()

    response = await safe_get_request(f"{API_BASE}/items/{set_slug}")
    if not response:
        arbitrage_data.pop(set_slug, None)
        return

    manifest = response.json().get('data', {})
    components = await get_components(manifest)

    if not components:
        arbitrage_data.pop(set_slug, None)
        return

    set_price = None
    total_parts_cost = 0
    data_incomplete = False

    for item in components:
        slug = item["slug"]
        quantity = item.get("quantity", 1)

        if slug == set_slug:
            set_price = await fetch_price_data(slug)
        else:
            price = await fetch_price_data(slug)
            if price is None:
                data_incomplete = True
                break
            total_parts_cost += price * quantity

    if data_incomplete or not set_price:
        arbitrage_data.pop(set_slug, None)
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
    else:
        # No longer profitable enough - remove any stale entry from a
        # previous cycle instead of leaving it behind.
        if arbitrage_data.pop(set_slug, None) is not None:
            print(f"No longer profitable, removed: {set_slug}")

def prune_delisted_sets(current_set_slugs):
    """
    Removes any tracked set that no longer appears in the live '_set'
    listing at all (renamed, delisted, vaulted-and-removed, etc).
    """
    stale_slugs = set(arbitrage_data.keys()) - current_set_slugs
    for slug in stale_slugs:
        arbitrage_data.pop(slug, None)
        print(f"Removed delisted/renamed set: {slug}")

async def fetch_and_update_arbitrage_data():
    config = read_config()
    while not shutdown_event.is_set():
        try:
            print(f"Cycle started: {datetime.now().strftime('%H:%M:%S')}")
            items = await fetch_all_items()
            print(f"Fetched {len(items) if items else 0} items")

            if items:
                sets = [i for i in items if i.get('slug', '').endswith('_set')]
                current_set_slugs = {s['slug'] for s in sets}

                # Only prune "no longer exists" entries when we actually
                # got a fresh, live listing. A transient fetch failure
                # (items is None/empty) must NOT be treated as "everything
                # got delisted".
                prune_delisted_sets(current_set_slugs)

                for set_item in sets:
                    if shutdown_event.is_set():
                        break
                    try:
                        await process_single_set(set_item['slug'])
                    except Exception as e:
                        # Don't let one bad set abort the whole cycle and
                        # leave the rest of the data unrefreshed.
                        print(f"Error processing {set_item.get('slug', '?')}: {e}")
            else:
                print("No items fetched this cycle (transient failure); "
                      "keeping existing data, skipping prune.")

            print("Cycle complete. Waiting for next interval...")
        except Exception as e:
            print(f"Loop error: {e}")

        for _ in range(int(config.get('RETRY_INTERVAL', 600))):
            if shutdown_event.is_set(): break
            await asyncio.sleep(1)

def is_data_fresh(entry, max_age_seconds):
    """
    Safety net: even if the background loop stalls or a cycle takes far
    longer than expected, don't serve arbitrarily old data out of the API.
    """
    try:
        updated = datetime.strptime(
            entry['last_updated'], '%Y-%m-%d %H:%M:%S'
        ).replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - updated).total_seconds()
        return age <= max_age_seconds
    except Exception:
        return False

@app.get("/")
@app.post("/")
async def get_arbitrage_opportunities():
    config = read_config()
    max_age = config.get('MAX_DATA_AGE_SECONDS', 1800)  # 30 min default

    fresh_data = [
        entry for entry in arbitrage_data.values()
        if is_data_fresh(entry, max_age)
    ]

    return sorted(fresh_data, key=lambda x: x['arbitrage_value'], reverse=True)

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