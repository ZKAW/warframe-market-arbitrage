import json
import asyncio
import httpx
import uvicorn

from fastapi import FastAPI
from datetime import datetime, timezone
from contextlib import asynccontextmanager

API_BASE = "https://api.warframe.market/v2"

app = FastAPI()

ducat_data = {}
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
    Returns the lowest platinum price currently listed, i.e. the
    cheapest we could actually buy the item for right now.
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

async def get_item_ducats(item, bulk_has_ducats):
    """
    Ducat value Baro Ki'Teer pays for this item.

    The v2 /items payload carries a 'ducats' field directly on eligible
    items, so normally no extra request is needed (fast path). If a given
    deployment's /items response doesn't include it for some reason, we
    fall back to hitting the item detail endpoint, but only for items
    tagged 'prime' -- those are the only ones that can realistically have
    a ducat value, so we don't waste requests scanning every mod/resource.
    """
    ducats = item.get('ducats')
    if ducats:
        return ducats

    if bulk_has_ducats:
        return None  # field exists in bulk payload, this item just has none

    if 'prime' not in item.get('tags', []):
        return None

    details = await get_item_details(item['slug'])
    if details is None:
        return None
    return safe_get_keys(details, 'ducats')

async def process_single_item(item, bulk_has_ducats):
    """
    Refreshes a single item's ducat-deal entry. Responsible for REMOVING
    the entry whenever the item no longer qualifies (lost its ducat value,
    price data unavailable, or ratio/ducats dropped below the configured
    thresholds) instead of leaving stale data behind.
    """
    config = read_config()
    slug = item['slug']

    ducats = await get_item_ducats(item, bulk_has_ducats)
    if not ducats:
        ducat_data.pop(slug, None)
        return

    price = await fetch_price_data(slug)
    if not price or price <= 0:
        ducat_data.pop(slug, None)
        return

    ratio = ducats / price

    if ratio < config.get('MIN_DUCAT_PER_PLATINUM', 0):
        ducat_data.pop(slug, None)
        return
    if ducats < config.get('MIN_DUCATS', 0):
        ducat_data.pop(slug, None)
        return

    ducat_data[slug] = {
        'item': slug,
        'ducats': ducats,
        'platinum_price': price,
        'ducat_per_platinum': round(ratio, 3), # higher the better
        'platinum_per_ducat': round(price / ducats, 3), # lower the better
        'market_url': f'https://warframe.market/items/{slug}',
        'last_updated': datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    }
    print(f"Good deal: {slug} ({ducats} ducats for {price}p, ratio {ratio:.2f})")

def prune_ineligible_items(current_candidate_slugs):
    """
    Removes any tracked item that's no longer a ducat-eligible candidate
    at all this cycle (delisted from the catalog, lost its 'prime' tag,
    etc). Mirrors process_single_item's per-item pop, but catches items
    that dropped out of the candidate set entirely and were therefore
    never visited by the loop below.
    """
    stale_slugs = set(ducat_data.keys()) - current_candidate_slugs
    for slug in stale_slugs:
        ducat_data.pop(slug, None)
        print(f"Removed no-longer-eligible/delisted item: {slug}")

async def fetch_and_update_ducat_data():
    config = read_config()
    while not shutdown_event.is_set():
        try:
            print(f"Cycle started: {datetime.now().strftime('%H:%M:%S')}")
            items = await fetch_all_items()
            print(f"Fetched {len(items) if items else 0} items")

            if items:
                bulk_has_ducats = any(i.get('ducats') for i in items)
                candidates = [
                    i for i in items
                    if i.get('ducats') or 'prime' in i.get('tags', [])
                ]
                print(f"Checking {len(candidates)} ducat-eligible candidates")

                # Only prune when we actually got a fresh, live listing.
                # A transient fetch failure (items is None/empty) must NOT
                # be treated as "everything became ineligible".
                current_candidate_slugs = {c['slug'] for c in candidates}
                prune_ineligible_items(current_candidate_slugs)

                for item in candidates:
                    if shutdown_event.is_set():
                        break
                    try:
                        await process_single_item(item, bulk_has_ducats)
                    except Exception as e:
                        # Don't let one bad item abort the whole cycle and
                        # leave the rest of the data unrefreshed.
                        print(f"Error processing {item.get('slug', '?')}: {e}")
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
async def get_best_ducat_deals():
    config = read_config()
    max_age = config.get('MAX_DATA_AGE_SECONDS', 1800)  # 30 min default

    fresh_data = [
        entry for entry in ducat_data.values()
        if is_data_fresh(entry, max_age)
    ]

    return sorted(fresh_data, key=lambda x: x['ducat_per_platinum'], reverse=True)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(timeout=30.0)
    background_task = asyncio.create_task(fetch_and_update_ducat_data())
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