# WordHunter Pocket - Google Play TODO

Ta lista dotyczy pierwszego wydania Android w Google Play. Kod buduje juz APK/AAB,
ale Play Console wymaga jeszcze rzeczy, ktorych nie da sie wygenerowac z repo.

## 1. Upload key

- [ ] Wygeneruj prywatny upload key lokalnie:

```powershell
$keyPath="$env:USERPROFILE\Documents\WordHunter\wordhunter-upload.jks"
New-Item -ItemType Directory -Force -Path (Split-Path $keyPath)
keytool -genkeypair -v -keystore $keyPath -alias wordhunter-upload -keyalg RSA -keysize 4096 -validity 10000 -storetype JKS
```

- [ ] Zapisz haslo w managerze hasel.
- [ ] Zrob backup pliku `.jks` poza repo.
- [ ] Nigdy nie commituj `.jks` ani hasel.
- [ ] Przed buildem do Play ustaw zmienne:

```powershell
$env:WH_ANDROID_KEYSTORE="$env:USERPROFILE\Documents\WordHunter\wordhunter-upload.jks"
$env:WH_ANDROID_KEY_ALIAS="wordhunter-upload"
$env:WH_ANDROID_KEYSTORE_PASSWORD="twoje_haslo"
$env:WH_ANDROID_KEY_PASSWORD="twoje_haslo"
.\build.bat play
```

- [ ] Sprawdz, ze `outputs\Word.Hunter.Pocket.release.aab` jest podpisany.

## 2. Privacy Policy URL

- [ ] Przygotuj publiczna strone z polityka prywatnosci.
- [ ] Najprosciej: GitHub Pages, np. `https://twoj-login.github.io/wordhunter/privacy.html`.
- [ ] W tresci opisz:
  - aplikacja nie wymaga konta,
  - aplikacja nie ma reklam,
  - ksiazki, teksty, fiszki, slowa i ustawienia sa przechowywane lokalnie,
  - synchronizacja uzywa folderu wybranego przez uzytkownika,
  - funkcje online moga laczyc sie z Gutenberg/Gutendex, slownikiem, TTS albo tlumaczem, jesli uzytkownik ich uzyje,
  - dane nie sa sprzedawane.
- [ ] Wklej URL w Play Console.

## 3. Data Safety

- [ ] Play Console -> App content -> Data safety.
- [ ] Odpowiedz zgodnie z realnym zachowaniem aplikacji.
- [ ] Przygotuj odpowiedzi dla:
  - lokalne dane nauki: slowa, statusy, fiszki, postep,
  - lokalne/importowane tresci: ksiazki i teksty uzytkownika,
  - opcjonalna synchronizacja przez folder wybrany przez uzytkownika,
  - opcjonalne polaczenia sieciowe do zrodel ksiazek/slownikow/tlumaczen/TTS,
  - brak reklam,
  - brak sprzedazy danych.

## 4. Store listing

- [ ] Nazwa: `Word Hunter Pocket`.
- [ ] Krotki opis.
- [ ] Pelny opis.
- [ ] Ikona aplikacji.
- [ ] Screenshoty z telefonu.
- [ ] Feature graphic, jesli Play Console wymaga dla wybranego typu publikacji.
- [ ] Dane kontaktowe developera.

## 5. Content rating

- [ ] Play Console -> App content -> Content rating.
- [ ] Wypelnij ankiete zgodnie z funkcjami aplikacji.
- [ ] Po ankiecie zapisz rating przed wyslaniem do review.

## 6. Test przed review

- [ ] Zbuduj podpisany AAB:

```powershell
.\build.bat play
```

- [ ] Wgraj AAB do Internal testing w Play Console.
- [ ] Zainstaluj aplikacje z Google Play Internal testing, nie tylko przez `adb`.
- [ ] Sprawdz:
  - pierwszy start i wybor jezyka,
  - import EPUB/TXT,
  - Gutenberg,
  - czytnik i oznaczanie slow,
  - TTS,
  - slownik,
  - fiszki,
  - synchronizacje folderu.

## 7. Przed production

- [ ] Zwieksz `versionCode` przed kolejnym uploadem.
- [ ] Zachowaj ten sam upload key dla kolejnych wersji.
- [ ] Nie wrzucaj niepodpisanego AAB do Play.
- [ ] Jesli Play Console zglosi problem, dopisz go tutaj jako kolejny punkt.

## Linki

- Play App Signing: https://support.google.com/googleplay/android-developer/answer/9842756
- Android app signing: https://developer.android.com/studio/publish/app-signing
- Privacy policy: https://support.google.com/googleplay/android-developer/answer/9859455
- Data safety: https://support.google.com/googleplay/android-developer/answer/10787469
- Store listing assets: https://support.google.com/googleplay/android-developer/answer/9866151
- Content rating: https://support.google.com/googleplay/android-developer/answer/9898843
