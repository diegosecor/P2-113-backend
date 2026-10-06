# Path Frequency backend

Run `npm start` from this folder. The API listens at `http://localhost:3000` by default.

It exposes profile, route-library, route-insight, and route-photo endpoints. Data is stored locally in `routes-store.json` (created on first save and ignored by Git).

The zone card uses OpenStreetMap reverse geocoding for the place name and creates a factual terrain summary from the uploaded route. To enable an optional OpenAI-written version of that summary, set both `OPENAI_API_KEY` and `OPENAI_MODEL` before starting the server; only the compact route statistics and midpoint are sent, never the full GPX file.

## Connecting the frontend

Deploy this API, then set its public URL in the main project's `dist/config.js` as `window.PATH_FREQUENCY_API_BASE`. The API allows cross-origin requests by default; in production, set `CORS_ORIGIN` to the exact frontend origin.
