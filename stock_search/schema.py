from typing import Literal

from pydantic import BaseModel, Field


class Quote(BaseModel):
    symbol: str = Field(default=None, description="The symbol of the quote")
    regular_price: str = Field(default=None, description="The regular price")
    regular_change: str = Field(default=None, description="The regular change")
    regular_change_percent: str = Field(default=None, description="The regular change percent")
    realtime_price: str = Field(default=None, description="The premarket / overnight price")
    realtime_change: str = Field(default=None, description="The premarket / overnight change")
    realtime_change_percent: str = Field(default=None, description="The premarket / overnight change percent")


class Holding(BaseModel):
    symbol: str = Field(default=None, description="The symbol of the holding")
    holding: str = Field(default=None, description="The name of the holding")
    weight: float = Field(default=None, description="The weight of the holding")


class Sector(BaseModel):
    sector: str = Field(default=None, description="The sector of the holding")
    weight: float = Field(default=None, description="The weight of the sector")


class ETF(BaseModel):
    top_holdings: list[Holding] = Field(default=None, description="The top holdings of the ETF")
    sectors: list[Sector] = Field(default=None, description="The sectors of the ETF")


class Portfolio(BaseModel):
    holdings: list[Holding] = Field(default=None, description="The holdings of the portfolio")


class News(BaseModel):
    title: str = Field(default=None, description="The title of the news article")
    url: str = Field(default=None, description="The URL of the news article")
    content: str = Field(default=None, description="The content of the news article")
    sentiment: Literal["positive", "neutral", "negative"] = Field(default=None, description="The sentiment of the news article")
    date: str = Field(default=None, description="The date of the news article")
