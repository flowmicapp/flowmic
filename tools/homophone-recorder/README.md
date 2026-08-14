# Homophone / idiom corpus recorder (C1)

Local loopback web UI so the owner can click-to-record 3–5 dense Chinese
homophone / idiom takes. Audio is written under **`.local/homophone-corpus/`**
(gitignored). **Never commit the audio.**

## Run

```bash
node tools/homophone-recorder/server.mjs
```

Open **`http://127.0.0.1:8797/`** in a desktop browser, allow the mic, record.

⚠️ **`127.0.0.1:8787` is the owner ruling desk** (`tools/owner-ruling-desk` —
「待您拍板」). That is a different tool. This recorder defaults to **8797**.

Optional env:

| Env | Default |
|---|---|
| `FLOWMIC_CORPUS_PORT` | `8797` |
| `FLOWMIC_CORPUS_DIR` | `<repo>/.local/homophone-corpus` |

## Layout after recording

```
.local/homophone-corpus/
  README.md
  manifest.json
  seg-01/
    script.txt
    take-<iso>.webm
    meta-latest.json
  seg-02/ …
```

A2-8 (eval harness) adopts takes from this directory when that card opens.
Scripts live in `scripts.json` (editable without touching the server).
