import time
import json
import requests
import asyncio
import uvicorn

from fastapi import FastAPI
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from threading import Thread
from datetime import datetime, timezone

app = FastAPI()

# Global in-memory storage for arbitrage opportunities
arbitrage_data = {}

def read_config():
    if not hasattr(read_config, "_config_data"):
        with open('config.json') as f:
            read_config._config_data = json.load(f)
    return read_config._config_data

def safe_get_request(url, params=None, retries=5):
    response = requests.get(url, params=params)
    time.sleep(read_config()['REQUEST_DELAY'])
    if response.status_code == 200:
        return response
    if response.status_code == 404:
        return None
    if retries == 0:
        print(f"Retries exhausted for {url}. Skipping...")
        return None

    delay = read_config()['RATE_LIMIT_DELAY']
    print(f"Rate limited. Waiting for {delay} seconds...")
    time.sleep(delay)
    return safe_get_request(url, params, retries - 1)

def safe_get_keys(data, *keys, default=None):
    try:
        for key in keys:
            data = data[key]
        return data
    except (KeyError, IndexError, TypeError):
        return default

def fetch_all_items():
    response = safe_get_request('https://api.warframe.market/v1/items')
    if response is None:
        return None

    return safe_get_keys(response.json(), 'payload', 'items')

def find_eligible_sets(items):
    return [item for item in items if item['url_name'].endswith('_set')]

def find_related_parts(set_name, all_items):
    base_name = set_name.replace('_set', '')
    return [item['url_name'] for item in all_items if item['url_name'].startswith(base_name) and not item['url_name'].endswith('_set')]

def get_volume(item_name):
    response = safe_get_request(f'https://api.warframe.market/v1/items/{item_name}/statistics')
    if response is None:
        return None

    return safe_get_keys(response.json(), 'payload', 'statistics_closed', '48hours', -1, 'volume')

def get_set_info(set_name):
    response = safe_get_request(f'https://api.warframe.market/v1/items/{set_name}')
    if response is None:
        return None

    return safe_get_keys(response.json(), 'payload', 'item')

def extract_quantity_from_item(item_name, set_info):
    if item_name.endswith('_set'):
        return 1
    for component in set_info['items_in_set']:
        if component['url_name'] == item_name:
            try:
                return int(component['quantity_for_set'])
            except (ValueError, KeyError):
                return 1

    return 1

def fetch_item_details(item_name, set_info=None):
    quantity = 1
    response = safe_get_request(f'https://api.warframe.market/v1/items/{item_name}/orders')
    if response is None:
        return None

    orders = safe_get_keys(response.json(), 'payload', 'orders')
    if orders is None:
        return None

    prices = [
        order['platinum'] for order in orders
        if order['order_type'] == 'sell'
        and order['region'] == 'en'
        and order['platform'] == 'pc'
        and order['user']['status'] == 'ingame'
    ]

    if set_info:
        quantity = extract_quantity_from_item(item_name, set_info)

    price = min(prices) if prices else None

    if price is None:
        return None

    return {
        'price': price,
        'quantity': quantity
    }

def fetch_set_price(set_name):
    set_data = fetch_item_details(set_name)

    if set_data is None or not set_data['price']:
        return None

    try:
        set_price = set_data['price']
    except (KeyError, IndexError):
        print(f"Failed to fetch price for {set_name}. Skipping...")
        return None

    return set_price

def fetch_part_prices(set_name, set_info, all_items):
    part_names = find_related_parts(set_name, all_items)
    part_prices = []
    for part_name in part_names:
        item = fetch_item_details(part_name, set_info)
        if item is None or not item:
            part_prices = [None]
            break
        part_prices.append(item['price'] * item['quantity'])

    return part_prices

def find_arbitrage_opportunities(sets, all_items):
    global arbitrage_data
    MIN_ARBITRAGE_VALUE = read_config()['MIN_ARBITRAGE_VALUE']
    MIN_VOLUME = read_config()['MIN_VOLUME']

    for set_item in sets:
        set_name = set_item['url_name']
        set_volume = get_volume(set_name)
        if set_volume is None or set_volume < MIN_VOLUME:
            print(f"Volume for {set_name} is too low", end="")
            if set_volume is not None:
                print(f" (was {set_volume}, required {MIN_VOLUME}). Skipping...", end="")
            print()
            continue
        set_info = get_set_info(set_name)

        set_price = fetch_set_price(set_name)
        if (set_info is None) or (set_price is None):
            continue

        print(f"Checking arbitrage opportunities for {set_name}...")
        part_prices = fetch_part_prices(set_name, set_info, all_items)

        if None in part_prices:
            print(f"Failed to fetch prices for {set_name}. Skipping...")
            continue

        total_part_price = sum(part_prices)
        if total_part_price == 0:
            continue
        arbitrage_value = set_price - total_part_price

        if arbitrage_value > MIN_ARBITRAGE_VALUE:
            opportunity = {
                'set': set_name,
                'set_price': set_price,
                'total_part_price': total_part_price,
                'arbitrage_value': arbitrage_value,
                'volume': set_volume,
                'market_url': f'https://warframe.market/items/{set_name}',
                'last_updated': datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
            }
            arbitrage_data[set_name] = opportunity
            print(f"Found arbitrage opportunity for {set_name}, arbitrage value: {arbitrage_value}\n")

async def fetch_and_update_arbitrage_data_async():
    while True:
        items = fetch_all_items()
        if items is None:
            continue

        sets = find_eligible_sets(items)
        find_arbitrage_opportunities(sets, items)

        await asyncio.sleep(read_config()['RETRY_INTERVAL'])  # Use asyncio.sleep for async sleep

def start_background_task():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(fetch_and_update_arbitrage_data_async())

@app.get("/")
@app.post("/")
async def get_arbitrage_opportunities():
    sorted_data = sorted(arbitrage_data.values(), key=lambda x: x['arbitrage_value'], reverse=True)
    return sorted_data


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = Thread(target=start_background_task)
    task.start()
    yield
    task.join()

app.router.lifespan_context = lifespan

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(read_config()['PORT']))
