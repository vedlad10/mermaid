-- 0017 — the patient's address, because a claim cannot be filed without it.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
-- Loop 2010BA of an 837D requires N3/N4 whenever the patient is the subscriber (SBR02 = 18), which
-- is the ordinary dental case. Mermaid carried name, date of birth and member id and nothing else,
-- so the 837 it produced was structurally incomplete and a real clearinghouse said so:
--
--     "Missing subscriber address and/or demographics. When the patient is the subscriber
--      (SBR-02 = 18), the subscriber address and demographics are required."
--
-- Every column is NULLABLE, deliberately. Existing patients were created before an address could be
-- collected, and back-filling them with a placeholder would put an invented address on a claim —
-- which is a false statement to a payer about where a patient lives. NULL means "not collected",
-- the claim scrubber blocks filing on it, and a person supplies it once. That is the correct
-- outcome: a claim that cannot be filed yet, rather than a claim filed wrongly.
--
-- `gender` is DMG03 on the same loop. `U` (unknown) is a valid X12 value and is what the codec
-- already defaults to, so this column only carries a real answer when someone gives one.

ALTER TABLE patients
  ADD COLUMN address_street TEXT,
  ADD COLUMN address_city   TEXT,
  ADD COLUMN address_state  TEXT,
  ADD COLUMN address_zip    TEXT,
  ADD COLUMN gender         TEXT;

-- Two-letter USPS state and a 5- or 9-digit ZIP are what an 837 accepts; anything else is rejected
-- by the payer after filing rather than by us before it. The constraints tolerate NULL so an
-- incomplete record is still storable — being unable to save a patient because their address is
-- missing would push staff to invent one, which is the failure this whole migration exists to avoid.
ALTER TABLE patients
  ADD CONSTRAINT patients_state_is_usps CHECK (address_state IS NULL OR address_state ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT patients_zip_is_postal CHECK (address_zip IS NULL OR address_zip ~ '^[0-9]{5}([0-9]{4})?$'),
  ADD CONSTRAINT patients_gender_is_x12 CHECK (gender IS NULL OR gender IN ('M', 'F', 'U'));

COMMENT ON COLUMN patients.address_street IS
  '837D loop 2010BA N3. NULL means not yet collected; the scrubber blocks filing rather than guessing.';
COMMENT ON COLUMN patients.address_zip IS
  '5 or 9 digits, no hyphen — the format an 837 carries.';
