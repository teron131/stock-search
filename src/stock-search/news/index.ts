/** Export the news provider adapters. */

export { getNewsAsync as getNews } from "./orchestrator.js";
export {
	getNewsExaAsync as getNewsExa,
	getNewsMassiveAsync as getNewsMassive,
	getNewsNewsApiAsync as getNewsNewsApi,
	getNewsNewsDataAsync as getNewsNewsData,
	getNewsYahooFinance as getNewsYfinance,
} from "./providers/index.js";
