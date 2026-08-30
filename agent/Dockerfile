FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# No bind-mounted state here (sessions live in memory only, reset via /reset) — a plain
# non-root user is enough, no ownership-fixing entrypoint needed like the bot's Dockerfile.
RUN useradd --system --no-create-home --uid 10001 appuser
USER appuser

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
