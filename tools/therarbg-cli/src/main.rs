mod scraper;

use clap::Parser;
use scraper::{Episode, TheRARBG};
use std::process;

/// TheRARBG torrent scraper CLI. Outputs JSON to stdout.
#[derive(Parser)]
#[command(name = "therarbg-cli", version)]
struct Cli {
    /// Search term (used when --imdb is not provided)
    #[arg(short, long)]
    query: Option<String>,

    /// IMDB ID to search by (e.g. tt1234567). Takes priority over --query.
    #[arg(short, long)]
    imdb: Option<String>,

    /// TV episodes to match, formatted as S01E02,S01E03 or as season packs S02
    #[arg(short, long, value_delimiter = ',')]
    episodes: Option<Vec<String>>,

    /// Proxy URL (e.g. socks5://127.0.0.1:9050)
    #[arg(short, long)]
    proxy: Option<String>,

    /// Maximum number of torrents to return
    #[arg(short, long)]
    limit: Option<usize>,
}

fn parse_episodes(raw: Vec<String>) -> anyhow::Result<Vec<Episode>> {
    let mut episodes = Vec::new();
    for entry in raw {
        let entry = entry.trim().to_uppercase();
        if entry.contains('E') {
            // Individual episode: S01E02
            let (s, e) = entry
                .strip_prefix('S')
                .and_then(|rest| rest.split_once('E'))
                .ok_or_else(|| anyhow::format_err!("Invalid episode format: {}", entry))?;
            episodes.push(Episode {
                season: s.parse()?,
                episode: e.parse()?,
            });
        } else {
            // Season pack: S02
            let s = entry
                .strip_prefix('S')
                .ok_or_else(|| anyhow::format_err!("Invalid season format: {}", entry))?;
            episodes.push(Episode {
                season: s.parse()?,
                episode: -1,
            });
        }
    }
    Ok(episodes)
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    if cli.query.is_none() && cli.imdb.is_none() {
        eprintln!("Error: either --query or --imdb must be provided");
        process::exit(1);
    }

    let scraper = match TheRARBG::new(cli.proxy.as_deref()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Error initialising scraper: {}", e);
            process::exit(1);
        }
    };

    let tv_episodes = match cli.episodes {
        Some(raw) => match parse_episodes(raw) {
            Ok(eps) => Some(eps),
            Err(e) => {
                eprintln!("Error parsing episodes: {}", e);
                process::exit(1);
            }
        },
        None => None,
    };

    let search_term = cli.query.unwrap_or_default();

    match scraper.search(search_term, cli.imdb, tv_episodes, cli.limit).await {
        Ok(results) => {
            println!("{}", serde_json::to_string_pretty(&results).unwrap());
        }
        Err(e) => {
            eprintln!("Error: {}", e);
            process::exit(1);
        }
    }
}
