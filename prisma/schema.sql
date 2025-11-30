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
CREATE INDEX idx_articles_published_at ON articles (published_at);