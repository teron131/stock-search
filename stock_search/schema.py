from typing import Literal

from pydantic import BaseModel, Field


class Quote(BaseModel):
    regular_price: str = Field(description="The regular price")
    regular_change: str = Field(description="The regular change")
    regular_change_percent: str = Field(description="The regular change percent")
    premarket_price: str = Field(description="The premarket/postmarket price")
    premarket_change: str = Field(description="The premarket/postmarket change")
    premarket_change_percent: str = Field(description="The premarket/postmarket change percent")


class News(BaseModel):
    title: str = Field(description="The title of the news article")
    url: str = Field(description="The URL of the news article")
    content: str = Field(None, description="The content of the news article")
    sentiment: Literal["positive", "neutral", "negative"] = Field(None, description="The sentiment of the news article")
    date: str = Field(None, description="The date of the news article")
