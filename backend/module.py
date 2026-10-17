from pydantic import BaseModel, Field


class SessionPayload(BaseModel):
    """Everything that touches conversation state carries a session id."""
    session_id: str = Field(..., min_length=8, max_length=64)


class ChatQuestion(SessionPayload):
    question: str = Field(..., min_length=1, max_length=50_000)


class JDText(SessionPayload):
    jd_text: str = Field(..., min_length=1, max_length=50_000)