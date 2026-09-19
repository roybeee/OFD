-- Photos are bounded immutable binary data, excluded from HR snapshots and projections.
CREATE TABLE oda_hr_photos (
  store_id text NOT NULL,
  handover_id text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) > 12 AND octet_length(bytes) <= 2097152),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, handover_id)
);
