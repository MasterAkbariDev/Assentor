export {
  resolvePackageRoot,
  defaultBinDir,
  defaultInstallHome,
  updateAssentor,
  uninstallAssentor,
  runScript,
} from "./lifecycle.js";
export {
  getLocalVersionSync,
  checkForUpdate,
  isRemoteNewer,
  parseSemver,
  readChangelog,
  ASSENTOR_CHANGELOG_URL,
  ASSENTOR_PACKAGE_URL,
  type UpdateCheckResult,
} from "./version.js";
