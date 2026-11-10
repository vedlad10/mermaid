/**
 * @mermaid/crypto — encryption for the few columns that hold raw PHI.
 *
 * Application-level rather than pgcrypto, so the key never becomes a query parameter and therefore
 * never reaches a query log. See src/phi.ts for the full reasoning and the storage format.
 */
export {
  encryptPhi,
  decryptPhi,
  isEncrypted,
  isRowBound,
  type PhiLocation,
  phiEncryptionEnabled,
  assertPhiKeyInProduction,
  readKey,
  PhiKeyError,
} from "./phi.ts";
