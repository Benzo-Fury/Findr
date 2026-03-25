/** A scored torrent result belonging to an index. */
export interface Torrent {
  id: string
  indexId: string
  title: string
  magnetLink: string
  sizeMB: number
  seeders: number
  leechers: number
  resolution: string | null
  videoCodec: string | null
  audioCodec: string | null
  hdrFormat: string | null
  releaseType: string | null
  uploaderName: string | null
  score: number
  createdAt: string
}

/** An indexed piece of content with all its associated torrents. */
export interface IndexWithTorrents {
  id: string
  imdbId: string
  season: number | null
  sourceId: string | null
  userId: string
  createdAt: string
  torrents: Torrent[]
}
