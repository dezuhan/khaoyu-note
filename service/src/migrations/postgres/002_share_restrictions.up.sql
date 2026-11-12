ALTER TABLE share_links ADD COLUMN watermark BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE share_links ADD COLUMN download_limit INTEGER;
ALTER TABLE share_links ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0;
