-- Hotfix (A9, Tiefenanalyse UI/Ausgabe/Bedienung): "source" ist das Quellenfeld des
-- Basiszinssatzes auf der Oberflaeche (Beispiel daneben: "Deutsche Bundesbank") und damit
-- § 288 BGB-relevant. loadBaseRates() (src/domain/dunning/base-rate.ts) schrieb dort bisher
-- den Entwicklervermerk "Selbstheilung Phase 14a" bei der Selbstheilung fehlender Historien.
-- Additiv: hebt NUR Bestandszeilen mit exakt diesem Platzhaltertext auf den neuen, neutralen
-- Text — andere Quellenwerte (z. B. "Migration Phase 14a", "Bundesbank", frei erfasste Texte)
-- bleiben unangetastet.
UPDATE "BaseInterestRate" SET "source" = 'Übernommen aus den Mahnwesen-Einstellungen' WHERE "source" = 'Selbstheilung Phase 14a';
