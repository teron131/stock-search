import os

from dotenv import load_dotenv
from langchain.prompts import ChatPromptTemplate
from langchain_google_genai import ChatGoogleGenerativeAI

load_dotenv()


def llm_formatter(content_list: list[str]) -> list[str]:
    """Format a list of content using LLM with a system prompt.

    Args:
        content_list (list[str]): A list of content to format

    Returns:
        list[str]: A list of formatted content
    """
    llm = ChatGoogleGenerativeAI(
        model=os.getenv("FAST_LLM"),
        temperature=0,
        api_key=os.getenv("GEMINI_API_KEY"),
        base_url="https://openrouter.ai/api/v1",
    )

    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """Extract and clean the main article content from the following web page text. 

KEEP:
- Main article title and content
- Publication date and author (if present)
- Main content of the article

REMOVE:
- Navigation menus and headers
- Advertisements and promotional content
- Cookie notices and pop-ups
- Social media buttons and related links
- Comments sections
- Footer content and site-wide elements

Return only the clean, readable article content in markdown format.""",
            ),
            ("human", "{content}"),
        ]
    )

    chain = prompt | llm

    results = chain.batch(content_list)
    return [result.content for result in results]


if __name__ == "__main__":
    content_list = [
        """
### News\n\n- Today\'s news\n- US\n- Politics\n- World\n- Tech\n    - Audio\n    - Computing\n    
- Gaming\n        - Wordle\n    - Home entertainment\n        - TVs\n    - Phones\n    - Science\n    - Streaming\n
- Streaming reviews\n    - VPN\n    - Wearables\n    - Deals\n    - Prime Day 2025\n        - Best Amazon Prime Day
deals\n    - More\n        - AI\n        - Apps\n        - AR and VR\n        - Business\n        - Cameras\n      
- Cyber security\n        - Entertainment\n        - General\n        - Smart home\n        - Social media\n       
- Transportation\n- Weather\n- Climate change\n- Health\n    - Wellness\n        - Mental health\n        - Sexual 
health\n        - Dermatology\n        - Oral health\n        - Hair loss\n        - Foot health\n    - Nutrition\n
- Healthy eating\n        - Meal delivery\n        - Weight loss\n        - Vitamins and supplements\n    - 
Fitness\n        - Equipment\n        - Exercise\n    - Women’s health\n    - Sleep\n    - Healthy aging\n        -
Hearing\n        - Mobility\n- Science\n- Originals\n    - The 360\n- Newsletters\n- Games\n\n### Life\n\n- 
Health\n    - Wellness\n        - Mental health\n        - Sexual health\n        - Dermatology\n        - Oral 
health\n        - Hair loss\n        - Foot health\n    - Nutrition\n        - Healthy eating\n        - Meal 
delivery\n        - Weight loss\n        - Vitamins and supplements\n    - Fitness\n        - Equipment\n        - 
Exercise\n    - Women’s health\n    - Sleep\n    - Healthy aging\n        - Hearing\n        - Mobility\n- 
Parenting\n    - Family health\n    - So mini ways\n- Style and beauty\n    - It Figures\n    - Unapologetically\n-
Horoscopes\n- Shopping\n    - Style\n        - Accessories\n        - Clothing\n        - Luggage\n        - 
Shoes\n    - Beauty\n        - Hair\n        - Makeup\n        - Skincare\n        - Sunscreen\n    - Health\n     
- Dental\n        - Fitness\n        - Hair loss\n        - Hearing aids\n        - Mental health\n        - 
Mobility\n        - Nutrition\n        - Personal care\n        - Sleep\n        - Women\'s health\n    - Home 
&amp; Garden\n        - Bedding\n        - Cleaning\n        - Gardening\n        - Kitchen\n        - Outdoor\n   
- Pets\n    - Tech\n        - Accessories\n        - Audio\n        - Auto\n        - Computers\n        - Phones\n
- Smart home\n        - TVs\n    - Gift ideas\n    - Stores\n        - Amazon\n        - Best Buy\n        - Home 
Depot\n        - Macy\'s\n        - Nordstrom\n        - Target\n        - Walmart\n        - Wayfair\n    - 
Shopping Guides\n        - Best non-toxic cutting boards\n        - Best heated socks\n        - Best body wash\n  
- Best cordless stick vacuums\n        - Best makeup removers\n    - Deals\n    - Father’s Day gifts\n        - 
Best Father’s Day gifts\n        - Best Father’s Day gifts under $50\n    - Prime Day 2025\n        - Best Amazon 
Prime Day deals\n- Food\n- Travel\n- Autos\n- Gift ideas\n- Buying guides\n\n### Entertainment\n\n- Celebrity\n- 
TV\n- Movies\n- Music\n- How to Watch\n- Interviews\n- Videos\n\n### Finance\n\n- My Portfolio\n- News\n    - 
Latest\n    - Stock Market\n    - Originals\n    - Tariff Updates\n    - Newsletters\n    - Economies\n    - 
Earnings\n    - Tech\n    - Housing\n    - Crypto\n    - Mergers &amp; IPOs\n    - Electric Vehicles\n    - 
Inflation\n- Markets\n    - Stocks: Most Actives\n    - Stocks: Gainers\n    - Stocks: Losers\n    - Trending 
Tickers\n    - Futures\n    - World Indices\n    - US Treasury Bonds Rates\n    - Currencies\n    - Crypto\n    - 
Top ETFs\n    - Top Mutual Funds\n    - Options: Highest Open Interest\n    - Options: Highest Implied Volatility\n
- Sectors\n    - Basic Materials\n    - Communication Services\n    - Consumer Cyclical\n    - Consumer Defensive\n
- Energy\n    - Financial Services\n    - Healthcare\n    - Industrials\n    - Real Estate\n    - Technology\n    -
Utilities\n    - Private Companies\n- Research\n    - Screeners\n    - Earnings Calendar\n    - Economic Calendar\n
- Stock Comparison\n    - Advanced Chart\n    - Currency Converter\n- Personal Finance\n    - Credit Cards\n    - 
Banking\n    - Student Loans\n    - Personal Loans\n    - Insurance\n    - Mortgages\n    - Mortgage Calculator\n  
- Taxes\n- Videos\n    - Latest\n    - Trending Stocks\n    - Market Sunrise\n    - Morning Brief\n    - Opening 
Bid\n    - All Shows\n    - Editor\'s Picks\n    - Stocks in Translation\n    - Trader Talk\n    - Financial 
Freestyle\n    - ETF Report\n- Watch Now\n\n### Sports\n\n- Fantasy\n    - News\n    - Fantasy football\n    - Best
ball\n    - Pro Pick \'Em\n    - College Pick \'Em\n    - Fantasy baseball\n    - Fantasy hockey\n    - Fantasy 
basketball\n    - Download the app\n- Daily fantasy\n- NFL\n    - News\n    - Scores and schedules\n    - 
Standings\n    - Stats\n    - Teams\n    - Players\n    - Drafts\n    - Injuries\n    - Odds\n    - Super Bowl\n   
- GameChannel\n    - Videos\n- NBA\n    - News\n    - Draft\n    - Scores and schedules\n    - Standings\n    - 
Stats\n    - Teams\n    - Players\n    - Inuries\n    - Videos\n    - Odds\n    - Playoffs\n- MLB\n    - News\n    
- Scores and schedules\n    - Standings\n    - Stats\n    - Teams\n    - Players\n    - Odds\n    - Videos\n    - 
World Baseball Classic\n- NHL\n    - News\n    - Scores and schedules\n    - Standings\n    - Stats\n    - Teams\n 
- Players\n    - Odds\n    - Playoffs\n- College football\n    - News\n    - Scores and schedules\n    - 
Standings\n    - Rankings\n    - Stats\n    - Teams\n- College basketball\n- Soccer\n    - News\n    - Scores and 
schedules\n    - Premier League\n    - MLS\n    - NWSL\n    - Liga MX\n    - CONCACAF League\n    - Champions 
League\n    - La Liga\n    - Serie A\n    - Bundesliga\n    - Ligue 1\n    - World Cup\n- NFL Draft\n- Yahoo Sports
AM\n- Show all\n    - WNBA\n    - Sportsbook\n    - NCAAF\n    - Tennis\n    - Golf\n    - NASCAR\n    - NCAAB\n   
- NCAAW\n    - Boxing\n    - USFL\n    - Cycling\n    - Motorsports\n    - Olympics\n    - Horse racing\n    - 
GameChannel\n    - Rivals\n    - Newsletters\n    - Podcasts\n    - Videos\n    - RSS\n    - Jobs\n    - Help\n    
- World Cup\n    - More news\n\n### New on Yahoo\n\n- Creators\n- Tech\n- Local services\n\n- Terms\n- Privacy\n- 
Privacy Dashboard\n- Feedback\n\n© 2025  All rights reserved.\n\n# Yahoo Finance\n\n- USEnglish\n- US y 
LATAMEspañol\n- AustraliaEnglish\n- CanadaEnglish\n- CanadaFrançais\n- DeutschlandDeutsch\n- FranceFrançais\n- 
香港繁中\n- MalaysiaEnglish\n- New ZealandEnglish\n- SingaporeEnglish\n- 台灣繁中\n- UKEnglish\n\n- News\n- 
Finance\n- Sports\n- More\n    - News\n        - Today\'s news\n        - US\n        - Politics\n        - World\n
- Weather\n        - Climate change\n        - Health\n        - Science\n        - Originals\n        - 
Newsletters\n        - Games\n    - Life\n        - Health\n        - Parenting\n        - Style and beauty\n      
- Horoscopes\n        - Shopping\n        - Food\n        - Travel\n        - Autos\n        - Gift ideas\n        
- Buying guides\n    - Entertainment\n        - Celebrity\n        - TV\n        - Movies\n        - Music\n       
- How to Watch\n        - Interviews\n        - Videos\n    - Finance\n        - My portfolio\n        - 
Watchlists\n        - Markets\n        - News\n        - Videos\n        - Screeners\n        - Personal finance\n 
- Crypto\n        - Sectors\n    - Sports\n        - Fantasy\n        - NFL\n        - NBA\n        - MLB\n        
- NHL\n        - College football\n        - College basketball\n        - Soccer\n        - NFL Draft\n        - 
Yahoo Sports AM\n        - New on Yahoo\n            - Creators\n            - Tech\n            - Local services\n
- Selected edition   USEnglish\n\n- My Portfolio\n- News\n    - Latest\n    - Stock Market\n    - Originals\n    - 
Tariff Updates\n    - Newsletters\n    - Economies\n    - Earnings\n    - Tech\n    - Housing\n    - Crypto\n    - 
Mergers &amp; IPOs\n    - Electric Vehicles\n    - Inflation\n- Markets\n    - Stocks: Most Actives\n    - Stocks: 
Gainers\n    - Stocks: Losers\n    - Trending Tickers\n    - Futures\n    - World Indices\n    - US Treasury Bonds 
Rates\n    - Currencies\n    - Crypto\n    - Top ETFs\n    - Top Mutual Funds\n    - Options: Highest Open 
Interest\n    - Options: Highest Implied Volatility\n    - Sectors\n    - Basic Materials\n    - Communication 
Services\n    - Consumer Cyclical\n    - Consumer Defensive\n    - Energy\n    - Financial Services\n    - 
Healthcare\n    - Industrials\n    - Real Estate\n    - Technology\n    - Utilities\n    - Private Companies\n- 
Research\n    - Screeners\n    - Earnings Calendar\n    - Economic Calendar\n    - Stock Comparison\n    - Advanced
Chart\n    - Currency Converter\n- Personal Finance\n    - Credit Cards\n    - Banking\n    - Student Loans\n    - 
Personal Loans\n    - Insurance\n    - Mortgages\n    - Mortgage Calculator\n    - Taxes\n- Videos\n    - Latest\n 
- Trending Stocks\n    - Market Sunrise\n    - Morning Brief\n    - Opening Bid\n    - All Shows\n    - Editor\'s 
Picks\n    - Stocks in Translation\n    - Trader Talk\n    - Financial Freestyle\n    - ETF Report\n- Watch 
Now\n\n<!-- image -->\n\n# Nvidia and Broadcom: Here\'s How These Top AI Stocks Are Doing 1 Year After Their Stock 
Splits\n\nAdria Cimino, The Motley Fool\n\n## In This Article:\n\n## Key Points\n\n- These leading AI players saw 
their shares skyrocket in the year prior to their stock splits, with levels reaching beyond $1,000.\n- Nvidia and 
Broadcom both have reported soaring demand for their products.\n- 10 stocks we like better than Nvidia ›\n\nStock 
splits were a big thing last year, with many major companies across industries launching such operations. Two of 
the most exciting were in the area of artificial intelligence (AI). Nvidia (NASDAQ: NVDA), the world\'s No. 1 AI 
chip designer, and Broadcom (NASDAQ: AVGO), a networking giant, completed stock splits in June and July 2024, 
respectively.\n\nWhat is a stock split, and why do companies go this route? These operations enable a company to 
bring down a soaring stock price to more reasonable levels, making the stock more accessible to a broader range of 
investors. Nvidia and Broadcom even said they decided on splits to make it easier for employees and investors to 
get in on their shares, which had surged more than 200% and about 100%, respectively, in 2023.\n\nStock splits 
don\'t change the total market value of the company or anything fundamental, though. They simply involve offering 
more shares to current holders according to the ratio of the split. So, for example, in a 10-for-1 stock split, if 
you originally held one share, you would hold 10 shares post-split -- but the total value of your holding would 
remain the same.\n\nBecause of this, a stock split alone isn\'t a reason to buy or sell a stock. Still, it\'s 
interesting to see how stock split players have performed a year after these operations, so let\'s take a look at 
both Nvidia and Broadcom a year after their splits.\n\nImage source: Getty Images.\n\n<!-- image -->\n\n## 
Nvidia\n\nNvidia completed its 10-for-1 stock split on June 7 of last year, with shares trading at the 
split-adjusted price as of June 10. This brought the shares down from about $1,200 to $120. Since that time, Nvidia
stock has experienced ups and downs, but it\'s delivered a gain of more than 40%.\n\nAs mentioned, this operation 
isn\'t the reason investors have flocked to Nvidia over the past year (though a lower price per share may have made
it easier for some to get in on the growth story). What has driven Nvidia\'s share price performance is the ongoing
high demand for its graphics processing units (GPUs), or AI chips, and related products and services.\n\nWhat also 
helped this AI leader was its strong execution of a big launch: Nvidia released its Blackwell architecture and chip
this past winter to demand that CEO Jensen Huang called "insane." The company generated $11 billion in revenue from
Blackwell in its very first quarter of commercialization and maintained a gross margin above 70%, ensuring high 
profitability on sales.\n\nAlthough investors worried about potential headwinds, such as import tariffs or a 
decrease in AI spending, these concerns have eased. Trade talks have spurred optimism that tariffs may not be as 
hefty as initially expected, and companies have reiterated their AI investment plans. All of this helped boost 
Nvidia\'s shares in recent weeks, even pushing the company to a $4 trillion market cap, making it the first company
ever to reach this level.\n\n## Broadcom\n\nBroadcom executed its stock split on July 12,\xa0and the stock began 
trading on July 15 at the new price. Like Nvidia, the company decided on a 10-for-1 split to bring its share price 
down -- in this case, from about $1,700 to $170. Broadcom stock has also climbed in the double digits since the 
operation, rising more than 65%.\n\nAnd like Nvidia, Broadcom saw its shares take off thanks to demand from AI 
customers. This company is a networking leader, making thousands of products used in a variety of locations -- from
your smartphone to major data centers. But in recent times, demand from big cloud service providers to support 
their AI development has helped revenue skyrocket.\n\nIn the most recent quarter, AI revenue surged 77% to $4.1 
billion, and the company says it expects this momentum to continue in the current quarter and through the next 
fiscal year. This is amid demand for both connectivity products and Broadcom\'s accelerated processing units 
(XPUs), a type of processor for specific AI tasks.\n\nThe company says its networking expertise and wide range of 
products -- from switches and routers to network interface cards (NICs), which connect computers to networks -- 
have been key growth drivers as cloud service providers ramp up their AI platforms.\n\nBroadcom stock followed a 
similar path to Nvidia, declining in April of this year due to general tariff concerns, but it has also rebounded 
and is on the rise today. The stock even closed at a record high just a few days ago.\n\n## Could the post-split 
success continue?\n\nBoth Nvidia and Broadcom have completed successful post-split years, scoring double-digit 
gains. Nvidia is slightly less expensive from a valuation standpoint than it was a year ago, but Broadcom\'s 
valuation has advanced.\n\nAVGO PE Ratio (Forward) data by YCharts. PE Ratio = price-to-earnings ratio.\n\n<!-- 
image -->\n\nStill, these AI players remain reasonably priced, considering their earnings track record and 
long-term prospects in this growth market. It\'s impossible, of course, to guarantee what these stocks will do 
next, but the current environment supports the idea of more gains ahead. Even more importantly, Nvidia and Broadcom
are well positioned to win in the AI market over the long run.\n\n## Should you buy stock in\xa0Nvidia right 
now?\n\nBefore you buy stock in Nvidia, consider this:\n\nThe Motley Fool Stock Advisor analyst team just 
identified what they believe are the\xa010 best stocks for investors to buy now… and Nvidia wasn’t one of them. The
10 stocks that made the cut could produce monster returns in the coming years.\n\nConsider when Netflix made this 
list on December 17, 2004... if you invested $1,000 at the time of our recommendation,\xa0you’d have $652,133!* Or 
when Nvidia made this list on April 15, 2005... if you invested $1,000 at the time of our recommendation, you’d 
have $1,056,790!*\n\nNow, it’s worth noting\xa0Stock Advisor’s total average return is 1,048% — a market-crushing 
outperformance compared to 180% for the S&amp;P 500. Don’t miss out on the latest top 10 list, available when you 
join Stock Advisor.\n\nSee the 10 stocks »\n\n*Stock Advisor returns as of July 15, 2025\n\nAdria Cimino has no 
position in any of the stocks mentioned. The Motley Fool has positions in and recommends Nvidia. The Motley Fool 
recommends Broadcom. The Motley Fool has a disclosure policy.\n\nNvidia and Broadcom: Here\'s How These Top AI 
Stocks Are Doing 1 Year After Their Stock Splits was originally published by The Motley Fool\n\n## Recommended 
Stories\n\nCopyright © 2025 Yahoo. All rights reserved.\n\nWhat\'s trending\n\nExplore more\n\nAbout\n\n- 
HTML\\_TAG\\_START HTML\\_TAG\\_END U.S. markets open in 3h 34m US Europe Asia Cryptocurrencies Rates Commodities 
Currencies HTML\\_TAG\\_START HTML\\_TAG\\_END HTML\\_TAG\\_START HTML\\_TAG\\_END\n    - S&amp;P Futures   
6,351.75 +17.00 (+0.27%)\n    - Dow Futures   44,657.00 +117.00 (+0.26%)\n    - Nasdaq Futures   23,289.25 +65.00 
(+0.28%)\n    - Russell 2000 Futures   2,265.20 +14.20 (+0.63%)\n    - VIX   16.90 +0.49 (+2.99%)\n    - Gold   
3,372.00 +13.70 (+0.41%)\n- Portfolio     Portfolio    Sign in to access your portfolio Sign in\n- Top gainers\n   
- STEM Stem, Inc. 13.50 +4.23 (+45.63%)\n    - TLN Talen Energy Corporation 328.63 +64.63 (+24.48%)\n    - CRSP 
CRISPR Therapeutics AG 65.13 +10.04 (+18.22%)\n    - IVZ Invesco Ltd. 19.92 +2.64 (+15.28%)\n    - SOC Sable 
Offshore Corp. 31.69 +3.35 (+11.82%)\n- Top losers\n    - MLGO MicroAlgo Inc. 14.66 -3.12 (-17.57%)\n    - ARWR 
Arrowhead Pharmaceuticals, Inc. 16.76 -2.09 (-11.09%)\n    - MOH Molina Healthcare, Inc. 182.98 -21.27 (-10.41%)\n 
- ELV Elevance Health, Inc. 277.09 -25.36 (-8.38%)\n    - STNE StoneCo Ltd. 13.67 -1.24 (-8.32%)\n- Most active\n  
- LCID Lucid Group, Inc. 3.0400 -0.0800 (-2.56%)\n    - QS QuantumScape Corporation 14.64 +1.04 (+7.65%)\n    - 
NVDA NVIDIA Corporation 172.41 -0.59 (-0.34%)\n    - WBD Warner Bros. Discovery, Inc. 12.75 -0.09 (-0.70%)\n    - 
TSLA Tesla, Inc. 329.65 +10.24 (+3.21%)\n- Earnings events\n- Trending tickers\n    - OPEN Opendoor Technologies 
Inc. 2.2500 +0.6000 (+36.36%)\n    - TSLA Tesla, Inc. 329.65 +10.24 (+3.21%)\n    - XYZ Block, Inc. 72.82 +2.09 
(+2.95%)\n    - NVTS Navitas Semiconductor Corporation 6.79 +0.52 (+8.29%)\n    - IXHL Incannex Healthcare Inc. 
0.6100 +0.2399 (+64.82%)\n- Top economic events    Top economic events    Singapore      There are no important 
events for this country at this time.  Select "All" to see top events in other countries or view all events. View 
All Events\n\nEdit your Dock
"""
    ]
    print(llm_formatter(content_list)[0])
