import { config } from './config';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HEADERS = {
  Language: 'en',
  Platform: 'pc',
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0',
};

export async function safeGetRequest(url, { retries = 5 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });

      if (res.status === 200) {
        await sleep(config.requestDelayMs);
        return res;
      }

      if (res.status === 404) {
        return null;
      }

      if (res.status === 429) {
        console.log(`Rate limited (429). Waiting ${config.rateLimitDelayMs / 1000}s...`);
        await sleep(config.rateLimitDelayMs);
        continue;
      }

      // Unexpected status: don't hot-loop against the API, back off a
      // little then let the retry loop try again.
      await sleep(1000);
    } catch (err) {
      console.log(`Request error: ${err.message}`);
      await sleep(2000);
    }
  }

  return null;
}
