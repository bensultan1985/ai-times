CREATE TABLE IF NOT EXISTS articles (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    subtitle VARCHAR(255),
    body TEXT NOT NULL,
    image_urls TEXT [],
    author VARCHAR(100),
    department VARCHAR(100),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    published_at DATE NOT NULL,
    test_data BOOLEAN DEFAULT FALSE,
    metadata JSONB
);
CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles (published_at);
CREATE TABLE IF NOT EXISTS comics (
    id SERIAL PRIMARY KEY,
    comic_type VARCHAR(50) NOT NULL,
    title VARCHAR(255),
    caption TEXT,
    image_url TEXT NOT NULL,
    published_at DATE NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    test_data BOOLEAN DEFAULT FALSE,
    metadata JSONB
);
CREATE INDEX IF NOT EXISTS idx_comics_published_at ON comics (published_at);
-- Weekly sitcom video experiment
CREATE TABLE IF NOT EXISTS video_episodes (
    id SERIAL PRIMARY KEY,
    week_key VARCHAR(20) NOT NULL UNIQUE,
    title VARCHAR(255),
    logline TEXT,
    script JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS video_segments (
    id SERIAL PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES video_episodes(id) ON DELETE CASCADE,
    segment_index INTEGER NOT NULL,
    segment_name VARCHAR(50) NOT NULL,
    video_url TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 12,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (episode_id, segment_index)
);
CREATE INDEX IF NOT EXISTS idx_video_segments_episode_id ON video_segments (episode_id);