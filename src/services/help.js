// Every station gets its own editable copy of the default guides.
export async function copyDefaultHelp(client, stationId) {
  await client.query(
    `INSERT INTO station_help (station_id, audience, source_slug, title, body, video_url, sort, published)
     SELECT $1, audience, slug, title, body, video_url, sort, published FROM help_articles
      WHERE published AND NOT EXISTS (SELECT 1 FROM station_help h WHERE h.station_id = $1 AND h.source_slug = help_articles.slug)`,
    [stationId]);
}
