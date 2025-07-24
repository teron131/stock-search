from typing import Literal

from pydantic import BaseModel, Field


class News(BaseModel):
    title: str = Field(description="The title of the news article")
    url: str = Field(description="The URL of the news article")
    content: str = Field(None, description="The content of the news article")
    sentiment: Literal["positive", "neutral", "negative"] = Field(None, description="The sentiment of the news article")
    date: str = Field(None, description="The date of the news article")
