// Immutable public release metadata generated from the reviewed private CHANGELOG.
// Explicit version validation prevents a stale public checkout from publishing
// notes describing a different tagged release.
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

const VERSION=/^\d+\.\d+\.\d+$/;

export function validateReleaseDetails(value, version) {
  if(!VERSION.test(String(version)) || !value || value.version!==version) {
    throw new Error("Public release details version does not match the tagged package version");
  }
  if(typeof value.title!=="string" || !value.title.trim() || value.title.length>220 || /[\r\n]/.test(value.title)) {
    throw new Error("Public release details title is missing or invalid");
  }
  if(!Array.isArray(value.changes) || value.changes.length<1 || value.changes.length>14 ||
     value.changes.some(text=>typeof text!=="string" || !text.trim() || text.length>1200 || /[\r\n]/.test(text))) {
    throw new Error("Public release details changes are missing or invalid");
  }
  return value;
}

export function releaseDetailsText(value,version,mode) {
  const details=validateReleaseDetails(value,version);
  if(mode==="title") return details.title;
  if(mode==="notes") return "## What's changed\n\n"+details.changes.map(change=>"- "+change).join("\n")+"\n\n";
  throw new Error("Expected release metadata mode: title or notes");
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const path=process.env.REMCP_RELEASE_DETAILS_PATH || resolve("release-details.json");
    const value=JSON.parse(readFileSync(path,"utf8"));
    process.stdout.write(releaseDetailsText(value,process.argv[2],process.argv[3]));
  } catch(error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
