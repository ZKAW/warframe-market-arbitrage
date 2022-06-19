import json
import time
import tabulate
import os

from urllib.request import urlopen


workspace = os.path.dirname(os.path.realpath(__file__))


def load_json(filename):
    with open(filename) as f:
        return json.load(f)

def write_json(filename, data):
    with open(filename, 'w') as f:
        json.dump(data, f, indent=4)
    return data

def load_prime_warframes():
    return load_json(os.path.join(workspace, 'assets', 'prime_warframes.json'))

def sort_table(table, index):
    return sorted(table, key=lambda x: x[index])

def print_table(results):
    headers = ['Warframe', 'Arbitration', 'Set Price', 'Parts Price', 'Market URL']
    table = []


    for market_name, arbitration_data in results.items():
        table.append([
            arbitration_data['display_name'],
            arbitration_data['arbitrage'],
            arbitration_data['set_price'],
            arbitration_data['parts_price'],
            arbitration_data['market_url']
        ])
    
    sorted_results = reversed(sort_table(table, 1))

    print(tabulate.tabulate(sorted_results, headers=headers, tablefmt='orgtbl'))

class Scraper:
    market_url = "https://warframe.market/items/"
    api_url = "https://api.warframe.market/v1/items/"

    def __init__(self, prime_warframes, min_arbitrage=20):
        self.prime_warframes = prime_warframes
        self.min_arbitrage = min_arbitrage
    
    def run(self):
        warframes_items = self.construct_warframes_items()
        warframes_prices = self.construct_warframes_prices(warframes_items)
        warframes_arbitrage = self.construct_warframes_arbitrage(warframes_prices)
        # sorted_arbitrage = sorted(warframes_arbitrage.items(), key=lambda x: x[1]['arbitrage'], reverse=True)

        # Write output
        if not os.path.exists(os.path.join(workspace, 'output')): os.makedirs(os.path.join(workspace, 'output'))
        write_json(os.path.join(workspace, 'output', 'warframes_arbitrage.json'), warframes_arbitrage)

        return warframes_arbitrage
    
    # Transform market_name to display_name
    def market_name_to_name(self, market_name):
        for warframe in self.prime_warframes:
            if warframe['market_name'] == market_name:
                return warframe['name']
        return None

    # Filter orders to only include valid orders (ingame, pc and seller)
    def filter_orders(self, orders):
        filtered_orders = []
        for order in orders:
            if order['user']['status'] != 'ingame': continue
            elif order['platform'] != 'pc': continue
            elif order['order_type'] != 'sell': continue

            filtered_orders.append(order)
        
        return filtered_orders
    
    # Filter arbitrage to only keep warframes with arbitrage > min_arbitrage
    def filter_arbitrage(self, warframes_arbitrage):
        filtered_arbitrage = {}
        for warframe_name, warframe_arbitrage in warframes_arbitrage.items():
            if warframe_arbitrage['arbitrage'] < self.min_arbitrage:
                continue
            filtered_arbitrage[warframe_name] = warframe_arbitrage

        return filtered_arbitrage

    # Get lowest price for a given item
    def get_lowest_price(self, item_name):
        url = self.api_url + item_name + "/orders"

        # Get orders
        main_url = urlopen(url)
        data = main_url.read()
        parsed = json.loads(data)

        # Filter orders
        orders = parsed['payload']['orders']
        filtered_orders = self.filter_orders(orders)

        # Get lowest price
        lowest_price = filtered_orders[0]['platinum']
        for order in filtered_orders:
            if order['platinum'] < lowest_price:
                lowest_price = order['platinum']

        return lowest_price

    # Construct dict of warframe parts with their respective market names
    def construct_warframes_items(self):
        warframes_items = {}

        for warframe in self.prime_warframes:
            warframe_name = warframe['market_name']

            warframe = {
                'set': warframe_name+'_set',
                'blueprint': warframe_name+'_blueprint',
                'systems': warframe_name+'_systems',
                'neuroptics': warframe_name+'_neuroptics',
                'chassis': warframe_name+'_chassis'
            }

            warframes_items[warframe_name] = warframe
        
        return warframes_items

    # Construct dict of warframe parts with their respective prices
    def construct_warframes_prices(self, warframes_items):
        warframes_prices = {}

        print("Getting prices...")

        count = 0
        for warframe_name, warframe_parts in warframes_items.items():
            count += 1
            warframes_prices[warframe_name] = {}

            for part_type, part_name in warframe_parts.items():
                while True:
                    try:
                        retry_amount = 0
                        warframes_prices[warframe_name][part_type] = self.get_lowest_price(part_name)
                        break
                    except KeyboardInterrupt:
                        break
                    except:
                        retry_amount += 1

                        if retry_amount >= 3:
                            try: warframes_prices.pop(warframe_name)
                            except: pass

                            print("Failed to get prices for " + warframe_name)
                            break

                        time.sleep(1.5)
                        continue
            
            # Warframe progress counter
            display_name = self.market_name_to_name(warframe_name)
            print(f"Processed {count}/{len(warframes_items)} warframes ({display_name})"+" "*10, end='\r')
            time.sleep(.5)
            # break

        print('\n')
        return warframes_prices
    
    # Construct dict of warframes with their respective arbitrage
    def construct_warframes_arbitrage(self, warframes_prices):
        warframes_arbitrage = {}

        for warframe_name, warframe_prices in warframes_prices.items():
            warframes_arbitrage[warframe_name] = {}
            total_parts_price = 0

            # Get part prices
            for part_type, part_price in warframe_prices.items():
                if part_type != 'set':
                    total_parts_price += part_price
            
            # Check if part prices are greater than set price or not
            if total_parts_price >= warframe_prices['set']:
                warframes_arbitrage[warframe_name]['arbitrage'] = total_parts_price - warframe_prices['set']
            else:
                warframes_arbitrage[warframe_name]['arbitrage'] = warframe_prices['set'] - total_parts_price

            # Set arbitrage data
            warframes_arbitrage[warframe_name]['parts_price'] = total_parts_price
            warframes_arbitrage[warframe_name]['set_price'] = warframe_prices['set']
            warframes_arbitrage[warframe_name]['market_url'] = self.market_url + warframe_name
            warframes_arbitrage[warframe_name]['display_name'] = self.market_name_to_name(warframe_name)
        
        # Remove warframes with arbitrage less than min_arbitrage
        warframes_arbitrage = self.filter_arbitrage(warframes_arbitrage)

        return warframes_arbitrage

# Run app
def main():
    prime_warframes = load_prime_warframes()
    scraper = Scraper(
        prime_warframes,
        min_arbitrage=30
    )

    results = scraper.run()
    print_table(results)

if __name__ == '__main__':
    main()