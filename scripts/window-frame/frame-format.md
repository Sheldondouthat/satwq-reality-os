# Window Frame Format — `gev-window-frame/1`

The Roku Window never renders data. The Node renders **frames** — finished
1920×1080 pictures of one room of the world model — and the channel displays
them. A frame is a record with its own timestamps, and it ages honestly.

## The pair

Each room publishes two files side by side at the frame base URL:

- `<room>.png` — the frame picture. It carries the frame record (below)
  embedded verbatim as a PNG `tEXt` chunk named `gev-frame`, so the picture
  and its provenance are one artifact, checkable from the bytes.
- `<room>.json` — the same frame record, for the channel to read without
  decoding the picture.

## The frame record

| field | meaning |
|---|---|
| `format` | `"gev-window-frame/1"` — the versioned format string |
| `room` | room id (`river`, `world`, `deck`, `mind`, `signals`) |
| `frame_file` | the PNG's file name, resolved against the frame base URL |
| `data_ts` / `data_epoch` | **the reading's own timestamp** (ISO + epoch seconds) — never the fetch time, never the render time |
| `data_ts_label` | the same instant, pre-formatted for the channel to print without date math |
| `rendered_ts` / `rendered_epoch` | when the Node rendered this frame |
| `age_at_render_seconds` | `rendered_ts − data_ts` at render time |
| `max_age_seconds` | the freshness budget of the underlying record's load-bearing leg |
| `freshness.verdict` | `CURRENT` or `STALE`, decided by the renderer from the record's own grammar (its own stale flag governs; else age vs max-age) |
| `freshness.basis` | why — one sentence, on the record |
| `renderer_epoch` | the renderer's build date; a channel older than the format it is fed must say so |
| `min_channel_format` | oldest channel format that may display this frame |
| `source` | registry record, station, and the compiled-output source the frame was rendered from |
| `values` | exactly the values drawn on the picture — the picture and the record cannot disagree |

## The laws

1. **The frame never looks fresher than its record.** The verdict is burned
   into the pixels at render time; the channel additionally re-checks
   `data_epoch + max_age_seconds` at display time and bands the frame STALE
   if it has crossed since rendering.
2. **No frame, no picture.** A room whose frame is unpublished shows an
   honest slate, never a fabricated frame.
3. **Format mismatch is a slate, not garbage.** A frame whose
   `min_channel_format` exceeds the channel's format shows
   "THE WINDOW IS BEING UPDATED" (Packaging Matrix, Roku row).
4. **The channel is viewer-only.** It holds no credential, sends nothing,
   and contains no code path that could send a command anywhere.
