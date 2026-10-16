"""
Pydantic request shapes for the FastAPI layer.

Renamed from module.py: `module` is too generic, and `chat` collided with
the route function in main.py.
"""
from pydantic import BaseModel, Field


class ChatQuestion(BaseModel):
    session_id: str = Field(..., min_length=8, max_length=64)
    question: str


class JDText(BaseModel):
    session_id: str = Field(..., min_length=8, max_length=64)
    jd_text: str = Field(..., min_length=1, max_length=50_000)