# Providers

Two kinds. **Local** providers run on your own hardware and need no key — they are
probed by endpoint. **Cloud** providers are bring-your-own-key.

```bash
node src/cli.ts provider list                      # everything, with key URLs
node src/cli.ts provider list --capability video   # just video-capable
node src/cli.ts provider probe                     # test everything
node src/cli.ts provider probe ollama              # test one
```

## Local

Nothing to buy, nothing to store. Start the software, point the studio at it.

| id | Software | Default endpoint | Get it |
|---|---|---|---|
| `ollama` | Ollama | `http://127.0.0.1:11434` | https://ollama.com/download |
| `lmstudio` | LM Studio | `http://127.0.0.1:1234/v1` | https://lmstudio.ai |
| `llamacpp` | llama.cpp server | `http://127.0.0.1:8080/v1` | https://github.com/ggml-org/llama.cpp |
| `vllm` | vLLM | `http://127.0.0.1:8000/v1` | https://docs.vllm.ai |
| `jan` | Jan | `http://127.0.0.1:1337/v1` | https://jan.ai |
| `koboldcpp` | KoboldCpp | `http://127.0.0.1:5001/v1` | https://github.com/LostRuins/koboldcpp |
| `textgen-webui` | Text Generation WebUI | `http://127.0.0.1:5000/v1` | https://github.com/oobabooga/text-generation-webui |
| `comfyui` | ComfyUI | `http://127.0.0.1:8188` | https://github.com/comfyanonymous/ComfyUI |

Ports move between versions and installs. Override per machine:

```bash
node src/cli.ts provider set-url lmstudio http://127.0.0.1:5000/v1
```

Fastest path from nothing to a working character:

```bash
ollama pull llama3.2
node src/cli.ts provider use text ollama
```

## Cloud (BYOK)

| id | Provider | Get a key | Env var |
|---|---|---|---|
| `higgsfield` | Higgsfield | https://cloud.higgsfield.ai | `HIGGSFIELD_API_KEY` |
| `anthropic` | Anthropic | https://console.anthropic.com/settings/keys | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI | https://platform.openai.com/api-keys | `OPENAI_API_KEY` |
| `google` | Google AI Studio | https://aistudio.google.com/apikey | `GEMINI_API_KEY` |
| `openrouter` | OpenRouter | https://openrouter.ai/keys | `OPENROUTER_API_KEY` |
| `groq` | Groq | https://console.groq.com/keys | `GROQ_API_KEY` |
| `together` | Together AI | https://api.together.xyz/settings/api-keys | `TOGETHER_API_KEY` |
| `fireworks` | Fireworks AI | https://fireworks.ai/account/api-keys | `FIREWORKS_API_KEY` |
| `mistral` | Mistral | https://console.mistral.ai/api-keys | `MISTRAL_API_KEY` |
| `deepseek` | DeepSeek | https://platform.deepseek.com/api_keys | `DEEPSEEK_API_KEY` |
| `xai` | xAI | https://console.x.ai | `XAI_API_KEY` |
| `cerebras` | Cerebras | https://cloud.cerebras.ai | `CEREBRAS_API_KEY` |
| `elevenlabs` | ElevenLabs | https://elevenlabs.io/app/settings/api-keys | `ELEVENLABS_API_KEY` |
| `replicate` | Replicate | https://replicate.com/account/api-tokens | `REPLICATE_API_TOKEN` |
| `fal` | fal.ai | https://fal.ai/dashboard/keys | `FAL_KEY` |
| `stability` | Stability AI | https://platform.stability.ai/account/keys | `STABILITY_API_KEY` |
| `huggingface` | Hugging Face | https://huggingface.co/settings/tokens | `HF_TOKEN` |

Console URLs move. If a link 404s, the id and env var still work — check the
provider's docs and correct the `keyUrl` in `src/providers/catalog.ts`; it is
plain data, one line per provider.

## Storing keys

```bash
node src/cli.ts provider set-key higgsfield hf-...
node src/cli.ts provider keys        # masked, shows which source each came from
node src/cli.ts provider rm-key higgsfield
```

Keys go to `.studio/keys.json` at mode 0600, gitignored. Resolution order is
**environment variable first, then keystore** — so CI and headless runs can inject
credentials without touching disk, and an env var always wins over a stale stored
key.

### Encryption at rest

Set `STUDIO_PASSPHRASE` before storing keys and values are sealed with AES-256-GCM
under a scrypt-derived key:

```bash
export STUDIO_PASSPHRASE='…'
node src/cli.ts provider set-key openai sk-...
```

The same passphrase must be present to read them back. Without it, `provider keys`
shows `••••(locked)` rather than failing.

Worth doing if `.studio/` sits on a synced volume — iCloud Drive, Dropbox and the
like copy file contents but not always the permission bits.

## Routing

Each capability has a default provider:

```bash
node src/cli.ts provider use text ollama
node src/cli.ts provider use video higgsfield
node src/cli.ts provider use voice elevenlabs
node src/cli.ts provider use image comfyui
```

Character minds use the `text` default unless the character names its own in
`mind.provider`. Asset jobs use the default for their kind's capability
(`animation` → video, `voiceline` → voice, `mesh3d` → mesh3d, everything else →
image) unless the job names one.

A useful split: local model for minds, since a heartbeat roster makes a lot of
small calls and latency does not matter; cloud for generation, where quality does.

## Wire protocols

Three adapters cover every text provider in the catalog:

- `openai-compatible` — `POST /chat/completions`. Most services.
- `ollama` — `POST /api/chat`, `format: "json"` for structured output.
- `anthropic` — `POST /messages`, system prompt carried out-of-band.

Adding a provider that speaks one of these is a single entry in
`src/providers/catalog.ts`. Image, video, voice and 3D providers vary too much to
share one adapter, so `renderRequest()` in `src/assets/queue.ts` emits a normalized
payload and the operator dispatches it — by HTTP with their own key, through a
local ComfyUI graph, or via an MCP client that already holds the credentials.
