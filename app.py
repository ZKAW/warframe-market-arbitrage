import requests
import time
import json

def read_config():
    with open('config.json') as f:
        return json.load(f)

def fetch_all_items():
    response = requests.get('https://api.warframe.market/v1/items')
    return response.json()['payload']['items']

def find_eligible_sets(items):
    return [item for item in items if item['url_name'].endswith('_set')]

def find_related_parts(set_name, all_items):
    base_name = set_name.replace('_set', '')
    return [item['url_name'] for item in all_items if item['url_name'].startswith(base_name) and not item['url_name'].endswith('_set')]

def fetch_item_price(item_name):
    # print("Fetching item price for:", item_name)
    response = requests.get(f'https://api.warframe.market/v1/items/{item_name}/orders')
    if response.status_code == 404:
        return None
    # if the error is a rate limit error, wait for a few seconds and try again
    if response.status_code != 200:
        print("Rate limited. Waiting for 1 second...")
        time.sleep(1)
        return fetch_item_price(item_name)
    orders = response.json()['payload']['orders']
    prices = [
        order['platinum'] for order in orders
        if order['order_type'] == 'sell'
        and order['region'] == 'en'
        and order['platform'] == 'pc'
        and order['user']['status'] == 'ingame'
    ]
    return min(prices) if prices else None

def find_arbitrage_opportunities(sets, all_items):
    opportunities = []
    MIN_ARBITRAGE_VALUE = read_config()['MIN_ARBITRAGE_VALUE']

    for set_item in sets:
        set_name = set_item['url_name']
        set_price = fetch_item_price(set_name)
        time.sleep(0.1)

        if set_price is None or not set_price:
            continue

        print(f"Checking arbitrage opportunities for {set_name}...")
        part_names = find_related_parts(set_name, all_items)
        # print(f"Related parts for {set_name}: {part_names}")
        part_prices = []
        for part_name in part_names:
            price = fetch_item_price(part_name)
            time.sleep(0.2)
            if price is None:
                part_prices = [None]
                break
            # print(f"Price for {part_name}: {price}")
            part_prices.append(price)

        if None in part_prices:
            print(f"Failed to fetch prices for {set_name}. Skipping...")
            continue

        # print(f"{set_name}: Set price: {set_price}, Part prices: {part_prices}")
        total_part_price = sum(part_prices)
        if total_part_price == 0:
            continue
        arbitrage_value = set_price - total_part_price

        if arbitrage_value > MIN_ARBITRAGE_VALUE:
            opportunities.append({
                'set': set_name,
                'set_price': set_price,
                'total_part_price': total_part_price,
                'arbitrage_value': arbitrage_value,
                'market_url': f'https://warframe.market/items/{set_name}'
            })
            print(f"Found arbitrage opportunity for {set_name}, arbitrage value: {arbitrage_value}\n")

    return opportunities

def main():
    items = fetch_all_items()
    sets = find_eligible_sets(items)
    opportunities = find_arbitrage_opportunities(sets, items)

    opportunities.sort(key=lambda o: o['arbitrage_value'], reverse=True)

    for opportunity in opportunities:
        print(json.dumps(opportunity, indent=4))

if __name__ == "__main__":
    main()
