# @findr/adapters

Unified adapters for interacting with torrent hosting services (EZTV, etc.).

Each service exposes data differently — some offer a full API, some a partial API, and others require scraping. Adapters normalize these differences behind a common interface so the rest of the app can query any service the same way.
