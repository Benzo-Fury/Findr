/**
 * The library of requested titles: every movie or show with at least one
 * download, most recently active first, each with its downloads. Narrow to one
 * TMDB identity with `tmdbId` and `mediaType` to ask "have I requested this?".
 */

import { ListTitlesQuerySchema, type Paginated, type TitleSummary } from "@findr/types/downloads"
import { Download } from "../../lib/db/models/Download"
import { Title } from "../../lib/db/models/Title"
import { factory } from "../../lib/routing/factory"
import { queryOf } from "../../lib/routing/input"

export default factory({
  GET: {
    query: ListTitlesQuerySchema,
    handler: (c) => {
      const query = queryOf(c, ListTitlesQuerySchema)
      const { items, total } = Title.list(query)

      // One query for every title's downloads on this page
      const downloads = Download.forTitles(items.map((title) => title.id))

      const page: Paginated<TitleSummary> = {
        items: items.map((title) =>
          title.toSummary((downloads.get(title.id) ?? []).map((download) => download.toSummary())),
        ),
        page: query.page,
        pageSize: query.pageSize,
        total,
      }
      return c.json(page)
    },
  },
})
