-- Vouch screenshots.
--
-- A vouch left in Discord can carry an image; the website showed the text and
-- dropped the picture, which is the half of a vouch people actually believe.
--
-- The bytes are stored here rather than the link for two reasons:
--
--   1. Discord CDN attachment URLs are signed and EXPIRE (the ?ex=&is=&hm=
--      query). Saving the URL would show the image today and 404 tomorrow —
--      a bug that only appears a day after it is shipped.
--   2. The whole point of this table is that it survives the Discord server.
--      A vouch archive whose images live on that server's CDN is not an
--      archive; /importvouches would rebuild a new server with dead images.
--
-- image_url keeps the original address anyway: it is the only way to tell a
-- vouch that never had a picture from one whose download failed and can be
-- retried.
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS image_url  TEXT,
  ADD COLUMN IF NOT EXISTS image_data BYTEA,
  ADD COLUMN IF NOT EXISTS image_mime TEXT;
