#!/bin/sh
# Laedt den KoSIT-Validator und die XRechnung-Konfiguration (Pins in assets/einvoice-validation/pins.env),
# prueft die SHA-256-Summen und legt sie unter <Zielordner> ab:
#   validator.jar, config/ (scenarios.xml, Schemas, Regeln), LICENSES/, VERSION.json
# Nutzung: scripts/fetch-einvoice-validator.sh <Zielordner>
#   Entwicklung/CI: scripts/fetch-einvoice-validator.sh validation/.cache/einvoice-validator
#   Image: Build-Stage im Dockerfile (Ziel /opt/validator).
# Benoetigt curl, unzip und sha256sum (oder shasum).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
pins="$here/../assets/einvoice-validation/pins.env"
[ -f "$pins" ] || { echo "FEHLER: $pins fehlt" >&2; exit 1; }
# shellcheck disable=SC1090
. "$pins"

target=${1:?"Zielordner fehlt"}
mkdir -p "$target"
target=$(cd "$target" && pwd)

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if [ -f "$target/VERSION.json" ] && grep -q "\"validatorSha256\": \"$VALIDATOR_SHA256\"" "$target/VERSION.json" \
   && grep -q "\"configSha256\": \"$CONFIG_SHA256\"" "$target/VERSION.json"; then
  echo "Pruefartefakte bereits vorhanden: $target"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fetch() { # url sha256 datei
  curl -fsSL --retry 3 -o "$3" "$1"
  actual=$(sha256_of "$3")
  [ "$actual" = "$2" ] || { echo "FEHLER: Pruefsumme von $1 weicht ab ($actual)" >&2; exit 1; }
}

fetch "$VALIDATOR_URL" "$VALIDATOR_SHA256" "$tmp/validator.jar"
fetch "$CONFIG_URL" "$CONFIG_SHA256" "$tmp/config.zip"
mkdir "$tmp/config"
unzip -q "$tmp/config.zip" -d "$tmp/config"
# Nicht benoetigte UBL-Hauptschemas (Ausschreibung, Bestellung ...) entfernen; Rechnung und Gutschrift bleiben.
for f in "$tmp"/config/resources/ubl/2.1/xsd/maindoc/*.xsd; do
  case "$(basename "$f")" in UBL-Invoice-2.1.xsd|UBL-CreditNote-2.1.xsd) ;; *) rm -f "$f" ;; esac
done
[ -f "$tmp/config/scenarios.xml" ] || { echo "FEHLER: scenarios.xml fehlt in der Konfiguration" >&2; exit 1; }

rm -rf "$target/config" "$target/LICENSES" "$target/validator.jar" "$target/VERSION.json"
mv "$tmp/validator.jar" "$target/validator.jar"
mv "$tmp/config" "$target/config"
mkdir "$target/LICENSES"
cp "$here"/../assets/einvoice-validation/LICENSES/* "$target/LICENSES/"
cat > "$target/VERSION.json" <<JSON
{
  "validator": "$VALIDATOR_VERSION",
  "configuration": "$CONFIG_VERSION",
  "validatorSha256": "$VALIDATOR_SHA256",
  "configSha256": "$CONFIG_SHA256"
}
JSON
echo "Pruefartefakte abgelegt: $target"
