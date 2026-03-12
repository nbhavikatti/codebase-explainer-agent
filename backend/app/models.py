from pydantic import BaseModel
class AnalyzeRequest(BaseModel):
    repo_url: str
class ChatRequest(BaseModel):
    repo_url: str
    question: str
    context: str = ""