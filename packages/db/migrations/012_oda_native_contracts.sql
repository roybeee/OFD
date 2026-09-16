-- Native contracts use one aggregate per employer/document, outside the HR workspace.
-- Existing HR records retain their original source and completion status.
CREATE UNIQUE INDEX IF NOT EXISTS oda_employer_business_scope_idx
ON aggregate_snapshots (store_id, (payload->>'businessNumber'))
WHERE aggregate_type = 'oda_employer';

CREATE INDEX IF NOT EXISTS oda_contract_employee_scope_idx
ON aggregate_snapshots (store_id, (payload->>'employeeActorId'), (payload->>'status'))
WHERE aggregate_type = 'oda_contract';

-- The runtime cannot replace the bytes of an already-created completed PDF.
-- Retention disposal must be implemented as a separate audited maintenance procedure;
-- no automatic deletion of a contract or evidence is introduced by this migration.
CREATE OR REPLACE FUNCTION protect_oda_contract_artifact()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  history_key text;
BEGIN
  IF OLD.aggregate_type = 'oda_contract_artifact' THEN
    RAISE EXCEPTION 'Completed contract artifacts are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.aggregate_type = 'oda_contract' AND OLD.payload->>'status' <> 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Requested and completed contract records cannot be deleted by runtime mutations'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
      OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
      OR NEW.store_id IS DISTINCT FROM OLD.store_id
      OR (NEW.payload - ARRAY['version','status','updatedAt','signatures','audit','deliveries',
          'completedAt','closedAt','closeReason','appliedAt','appliedBy','artifacts'])
         IS DISTINCT FROM
         (OLD.payload - ARRAY['version','status','updatedAt','signatures','audit','deliveries',
          'completedAt','closedAt','closeReason','appliedAt','appliedBy','artifacts']) THEN
      RAISE EXCEPTION 'Requested contract parties and document contents are frozen'
        USING ERRCODE = '23514';
    END IF;
    -- The final signature attaches immutable PDF references exactly once.
    IF NEW.payload->'artifacts' IS DISTINCT FROM OLD.payload->'artifacts'
      AND NOT (OLD.payload->>'status' = 'pending'
        AND NEW.payload->>'status' = 'completed'
        AND NOT (OLD.payload ? 'artifacts')
        AND jsonb_typeof(NEW.payload->'artifacts') = 'object') THEN
      RAISE EXCEPTION 'Completed artifact references are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.payload->>'status' IN ('completed','declined','cancelled')
      AND NEW.payload->>'status' IS DISTINCT FROM OLD.payload->>'status' THEN
      RAISE EXCEPTION 'Closed contracts cannot reopen' USING ERRCODE = '23514';
    END IF;
    IF OLD.payload->>'status' <> 'pending'
      AND NEW.payload->'signatures' IS DISTINCT FROM OLD.payload->'signatures' THEN
      RAISE EXCEPTION 'Closed contract signatures are immutable' USING ERRCODE = '23514';
    END IF;
    -- Existing events and signatures must remain exact prefixes, even when
    -- a runtime bug attempts to rewrite the entire aggregate.
    FOREACH history_key IN ARRAY ARRAY['signatures','audit','deliveries'] LOOP
      IF jsonb_typeof(NEW.payload->history_key) IS DISTINCT FROM 'array'
        OR jsonb_array_length(NEW.payload->history_key) < jsonb_array_length(OLD.payload->history_key)
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(OLD.payload->history_key) WITH ORDINALITY AS old_item(value, ord)
          WHERE old_item.value IS DISTINCT FROM (NEW.payload->history_key)->(old_item.ord::integer - 1)
        ) THEN
        RAISE EXCEPTION 'Contract evidence is append only' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    FOREACH history_key IN ARRAY ARRAY['completedAt','closedAt','closeReason','appliedAt','appliedBy'] LOOP
      IF OLD.payload ? history_key AND NEW.payload->history_key IS DISTINCT FROM OLD.payload->history_key THEN
        RAISE EXCEPTION 'Recorded contract outcomes are immutable' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER oda_contract_artifact_immutable
BEFORE UPDATE OR DELETE ON aggregate_snapshots
FOR EACH ROW EXECUTE FUNCTION protect_oda_contract_artifact();
