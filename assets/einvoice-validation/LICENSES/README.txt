# Pruefartefakte fuer eingehende E-Rechnungen

Das Image prueft angenommene E-Rechnungen mit dem Validator der Koordinierungsstelle fuer IT-Standards (KoSIT)
in einem eigenen Prozess. Die Artefakte werden beim Bau des Images geladen (Pruefsummen in `pins.env`) und
unveraendert weitergegeben; die Lizenztexte liegen hier und im Image unter `/opt/validator/LICENSES`.

| Bestandteil | Lizenz | Quelle |
|---|---|---|
| KoSIT-Validator 1.6.3 (enthaelt u. a. Saxon-HE unter MPL 2.0, JAXB unter EDL 1.0) | Apache-2.0, siehe `NOTICE-validator.txt` | https://github.com/itplr-kosit/validator |
| Validator-Konfiguration XRechnung 3.0.2 (Szenarien, XRechnung-Regeln) | Apache-2.0 | https://github.com/itplr-kosit/validator-configuration-xrechnung |
| Regeln EN 16931 (Schematron/XSL, aus `ConnectingEurope/eInvoicing-EN16931`, Tag `validation-1.3.17`) | EUPL-1.2 (kompatibel mit AGPL-3.0) | https://github.com/ConnectingEurope/eInvoicing-EN16931 |
| UBL-2.1-Schemas (OASIS), CII-Schemas D16B (UN/CEFACT) | Urheberhinweise stehen in den Dateien und bleiben unveraendert | in der Validator-Konfiguration |
| Laufzeitumgebung (zugeschnittenes OpenJDK 21) | GPL-2.0 mit Classpath Exception; Texte im Verzeichnis `legal` der Laufzeitumgebung | Debian-Paket `openjdk-21-jdk-headless` |

Der Validator wird nur als eigenes Programm aufgerufen (keine Bibliothek im Anwendungsprozess).
