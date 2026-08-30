import os

# One env var (STRANDS_MODEL_PROVIDER) picks the model backend, using Strands' own
# provider abstraction. Anthropic is the default for local dev (just needs an API key);
# Bedrock and Ollama are drop-in swaps for later.


def build_model():
    provider = os.environ.get("STRANDS_MODEL_PROVIDER", "anthropic").lower()
    model_id = os.environ.get("STRANDS_MODEL_ID")

    if provider == "anthropic":
        from strands.models.anthropic import AnthropicModel

        client_args = {"api_key": os.environ["ANTHROPIC_API_KEY"]}
        # Only needed for "identity-linked" API keys scoped to multiple workspaces.
        # Anthropic then requires a workspace id on every request. A key scoped to a
        # single workspace (the default when you create one on platform.claude.com)
        # doesn't need this at all.
        workspace_id = os.environ.get("ANTHROPIC_WORKSPACE_ID")
        if workspace_id:
            client_args["workspace_id"] = workspace_id

        return AnthropicModel(
            # Haiku is Anthropic's cheapest current tier and handles this bounded,
            # fixed-tool-set queue-management task fine. No need for a bigger model.
            client_args=client_args,
            model_id=model_id or "claude-haiku-4-5-20251001",
            max_tokens=2048,
        )

    if provider == "bedrock":
        from strands.models import BedrockModel

        if not model_id:
            raise ValueError("STRANDS_MODEL_ID is required when STRANDS_MODEL_PROVIDER=bedrock")
        return BedrockModel(model_id=model_id)

    if provider == "ollama":
        from strands.models.ollama import OllamaModel

        if not model_id:
            raise ValueError("STRANDS_MODEL_ID is required when STRANDS_MODEL_PROVIDER=ollama")
        return OllamaModel(host=os.environ.get("OLLAMA_HOST", "http://localhost:11434"), model_id=model_id)

    raise ValueError(f"Unknown STRANDS_MODEL_PROVIDER: {provider!r} (expected anthropic, bedrock, or ollama)")
