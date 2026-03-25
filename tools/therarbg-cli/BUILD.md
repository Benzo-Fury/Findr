# Building therarbg-cli

Requires [Rust](https://rustup.rs/) (1.85+).

```bash
cd therarbg-cli
cargo build --release
```

Binary will be at `target/release/therarbg-cli`.

## Usage

```bash
# Search by IMDB ID (movie)
therarbg-cli --imdb tt1234567

# Search by query
therarbg-cli --query "The Matrix"

# TV show - specific episodes
therarbg-cli --imdb tt1234567 --episodes S01E01,S01E02

# TV show - full season pack
therarbg-cli --imdb tt1234567 --episodes S02

# With proxy
therarbg-cli --imdb tt1234567 --proxy socks5://127.0.0.1:9050
```

Outputs JSON to stdout. Errors go to stderr. Exit code 1 on failure.
