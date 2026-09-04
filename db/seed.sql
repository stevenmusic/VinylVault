-- 選用：範例資料，方便第一次串接時看到畫面。
-- 執行：turso db shell vinylvault-db < db/seed.sql

INSERT INTO artists (name, sort_name, country, image_url, notes) VALUES
  ('Taylor Swift', 'Swift, Taylor', 'US', NULL, '示範資料'),
  ('Radiohead',    'Radiohead',     'UK', NULL, '示範資料');

INSERT INTO albums (artist_id, title, release_year, label, notes) VALUES
  ((SELECT id FROM artists WHERE name = 'Taylor Swift'), 'Midnights',  2022, 'Republic', '示範資料'),
  ((SELECT id FROM artists WHERE name = 'Radiohead'),    'In Rainbows', 2007, 'XL',      '示範資料');

INSERT INTO versions
  (album_id, name, color, color_hex, is_limited, is_exclusive, exclusive_to, region,
   release_date, edition_size, price, currency, buy_url, want, owned, notes)
VALUES
  ((SELECT id FROM albums WHERE title = 'Midnights'),
   'Jade Green Edition', 'Jade Green', '#4F7A5C', 1, 1, 'Official Store', 'US',
   '2022-10-21', 5000, 34.99, 'USD', NULL, 1, 0, '示範資料'),
  ((SELECT id FROM albums WHERE title = 'Midnights'),
   'Blood Moon Edition', 'Marbled Red', '#8E2F2F', 1, 0, NULL, 'UK',
   '2022-10-21', NULL, 32.00, 'GBP', NULL, 0, 1, '示範資料'),
  ((SELECT id FROM albums WHERE title = 'In Rainbows'),
   'Standard Black', 'Black', '#0C0A07', 0, 0, NULL, 'EU',
   '2007-12-31', NULL, 28.00, 'EUR', NULL, 0, 1, '示範資料');
