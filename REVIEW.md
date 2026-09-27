# elfinder-next — İyileştirme Planı

Kod incelemesi: 2026-09-12 (2. tur) · İncelenen sürüm: `0.1.1` (commit `b9c1bef`)

Dosya referansları `packages/elfinder-next/src/` altına göredir.

---

## Uygulanan dilim

`fix/security-and-core-hardening` dalında 10 commit. Tamamlanan maddeler:

| Madde | Konu |
|---|---|
| 1 | Chunk yüklemede iki dizin geçişi |
| 2 | Arşiv entry doğrulama ve tavanlar (bulgu daraldı, aşağıya bak) |
| 3, 4 | HTML/SVG inline servis edilmesi, Content-Disposition |
| 5, 20 | elFinder hata kodları, HTTP 200, yol sızıntısı |
| 6 | Sembolik bağlantı çözümlemesi |
| 7, 8 | rename/paste veri kaybı, geçersiz hash |
| 9 | Tembel thumbnail üretimi |
| 12 | Akış ve HTTP Range (yalnızca indirme tarafı) |
| 44 | Boş `publicUrl` desteği |
| 46-49 | Depo düzeni |
| 51, 52 | vitest sözleşme testleri ve GitHub Actions CI |

Her değişiklik, düzeltme geri alınmış halde koşturulan bir kontrol denemesiyle
doğrulandı. Geçici betikler artık  altında kalıcı
vitest paketine dönüştü: 99 test, orijinal kaynağa karşı koşturulduğunda 44'ü
başarısız oluyor.

**Açıkta kalan, bu dilimde kapsam dışı olanlar:** madde 10 (bayat thumbnail),
11 (öksüz thumbnail), 13 (chunk çöpü), 14 (auth kancaları), 15-19 ve 21-30
(protokol), 31-43 (mimari ve dağıtım), 45, 50-59 (hijyen ve testler).

---

## İkinci turda değişenler

Yeni bulgular:

- **Yeni P0:** `rename` ve kes-yapıştır hedefteki dosyayı sessizce yok ediyor (madde 7, doğrulandı)
- **Yeni P0:** Geçersiz hash sessizce köke çözülüyor, dosyalar yanlış klasöre gidiyor (madde 8, doğrulandı)
- **Yeni P2:** `extract` sonucu, `_chunkmerged` sapması, sırasız chunk yarışı, `tree=1` yok sayılıyor
- **Yeni P3:** `.chunks` dizini `public/` altında, yani yarım yüklemeler herkese açık
- **Yeni P2:** Varsayılan yapılandırma serverless ortamlarda çalışmıyor, `output: "standalone"` altında da bozuk (madde 42-45, Next dokümanına karşı doğrulandı)
- **Yeni P3:** Doğrulanmış depo sorunları: iç içe pnpm workspace, karışık lockfile, commit'lenmiş build artefaktı

Düzeltme:

- İlk turda "elFinder hata dizisi beklemezse bilinmeyen hata gösterir" demiştim, bu fazla kesindi.
  İstemci düz metni de gösterebiliyor. Asıl sorun HTTP durum kodu. Madde 20'de düzeltildi.

---

## Öncelik sırası

1. İki dizin geçişi açığı + saklanan XSS (P0 güvenlik)
2. İki sessiz veri kaybı hatası (P0 veri kaybı)
3. Listelemede thumbnail üretimi + akışa çevirme (P1)
4. Auth / izin kancaları (P1)
5. Protokol uyumsuzlukları (P2)
6. Mimari ayrıştırma ve dağıtım (P2)
7. Paketleme ve depo hijyeni (P3)

---

## P0 — Güvenlik

### 1. Chunk yüklemede dizin dışına yazma — YAPILDI

**Yer:** `handler-core.ts:868-875`

İstemciden gelen `cid` ve `chunk` alanları temizlenmeden dosya yolu kurmakta kullanılıyor. Doğrulanmış davranış:

```
path.resolve('C:/up/.chunks', '../../../evil')       -> C:\evil
path.posix.basename('..\..\evil.txt')                -> ..\..\evil.txt
path.resolve('C:/up/.chunks', '..\..\evil.txt')      -> C:\evil.txt
```

`path.posix.basename` ters slash'ı ayırıcı saymıyor, bu yüzden Windows'ta `chunk` alanı da geçiş veriyor. Linux'ta `cid` vektörü çalışıyor.

Kimliği doğrulanmamış bir istek `uploadDir` dışında klasör açıp dosya yazabiliyor. Diğer tüm yollar `resolveWithinRoot` (`handler-core.ts:111`) çitinden geçiyor, sadece bu ikisi geçmiyor.

> Not: `resolveWithinRoot`'un kendisi sağlam. Windows'ta `C:/Windows/x` gibi mutlak bir
> girdi `path.resolve` tarafından kök dışına çözülse bile `startsWith` kontrolü yakalıyor.
> Sorun o fonksiyonda değil, onu atlayan iki çağrıda.

- [x] `cid` değerini `normalizeRelativePath` ile süz, tek segmente indir
- [x] `chunk` adını hem `/` hem `\` için normalize et, tek segmente indir
- [x] İkisini de `resolveWithinRoot` benzeri bir kontrolden geçir
- [x] Regresyon testi yaz (her iki vektör için)

### 2. ZIP Slip + zip bomb — YAPILDI, bulgu daraldı

**Yer:** `handler-core.ts:707`

Uygulama sırasında ölçüldü, ilk turdaki iddia olduğu gibi çıkmadı:

- **ZIP Slip sömürülebilir değildi.** adm-zip 0.5.17 entry adındaki `../` ve `..\`
  öneklerini sessizce kırpıp dosyayı çıktı klasörüne düzleştiriyor. Elle üretilmiş
  bir arşivle doğrulandı (adm-zip'in `addFile` metodu adları temizlediği için
  kötü niyetli arşiv onunla üretilemiyor). Düzeltme öncesi hiçbir dosya kök
  dışına çıkmadı.
- **Tavanlar gerçekten eksikti.** 5 entry limitine karşı 12 entry'li arşiv, 1 KiB
  limitine karşı 4 KiB yük sorunsuz açıldı, çünkü hiç limit yoktu.

Yapılan: `extract` artık entry'leri kendisi dolaşıyor, `safeEntryPath` mutlak yol,
ters slash, `..` ve kontrol karakterlerini reddediyor, her hedef `assertWithin` ile
yeniden kontrol ediliyor. Kötü niyetli entry sessizce başka yere yazılmak yerine
`errArcSymlinks` ile reddediliyor. Doğrulama ilk bayt yazılmadan bitiyor.
`maxArchiveEntries` (10000) ve `maxArchiveBytes` (1 GiB) seçenek olarak eklendi.

- [x] Entry adlarını açmadan önce tek tek doğrula
- [x] Toplam açılmış boyut için tavan koy
- [x] Entry sayısı için tavan koy

### 3. Saklanan XSS — YAPILDI

Varsayılan kurulumda dosyalar `public/uploads` altına yazılıyor ve Next statik sunucusu bunları uygulamayla **aynı origin**'den servis ediyor. Kullanıcı bir `.html` veya `.svg` yüklerse o kaynak sizin origin'inizde çalışır, oturum çerezlerine erişir.

`handleFile` de `download=1` gelmediğinde `Content-Disposition: inline` döndürerek aynı sorunu üretiyor.

- [x] Tüm dosya yanıtlarına `X-Content-Type-Options: nosniff` ekle
- [x] Güvenli olmayan MIME türlerini her zaman `attachment` olarak zorla
- [x] README'de dosyaların `public/` dışında tutulup `cmd=file` üzerinden servis edilmesini öner

### 4. Content-Disposition başlık enjeksiyonu — YAPILDI

**Yer:** `handler-core.ts:480`

Dosya adı tırnak içine kaçışsız gömülüyor. İçinde `"` geçen bir ad başlık enjeksiyonu yapar, ASCII dışı adlar bozulur.

- [x] RFC 5987 biçimine geç:

```ts
`attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
```

### 5. Hata mesajlarında yol sızıntısı — YAPILDI

**Yer:** `handler-core.ts:970` ve `handler-core.ts:1003`

Ham `fs` hata mesajları aynen dışarı veriliyor, sunucudaki mutlak dosya yollarını sızdırıyor.

- [x] Hataları elFinder hata kodlarına eşle, ham mesajı sadece logla

### 6. Sembolik bağlantı kontrolü — YAPILDI

`resolveWithinRoot` yalnızca sözdizimsel kontrol yapıyor. Sembolik bağlantılar kökten dışarı çıkabilir.

- [x] `fs.realpath` ile doğrula

---

## P0 — Sessiz veri kaybı

### 7. rename ve kes-yapıştır hedefi yok ediyor — YAPILDI

**Yer:** `handleRename` → `handler-core.ts:445`, `movePath` → `handler-core.ts:308`

`fs.rename` hedefte aynı adda bir dosya varsa onu sessizce siler. Node'da doğruladım:

```
a.txt = "AAA", b.txt = "BBB"
fs.renameSync('a.txt','b.txt')
b.txt -> "AAA"     (BBB kayboldu, hata yok, uyarı yok)
```

Yani `a.jpg` dosyasını `b.jpg` olarak yeniden adlandırmak, var olan `b.jpg`'yi yok ediyor. Aynı şey `handlePaste`'in `cut` dalı için de geçerli, çünkü `movePath` önce `fs.rename` deniyor.

Daha kötüsü tutarsız olması. Kopyala dalı `errorOnExist: true` kullandığı için 500 fırlatıyor, kes dalı ise sessizce üzerine yazıyor. elFinder bu durumda `errExists` bekliyor ve kullanıcıya "üzerine yaz / yeniden adlandır" sorusunu soruyor.

- [x] `rename` öncesi hedefin varlığını kontrol et
- [x] `movePath` öncesi hedefin varlığını kontrol et
- [x] Var ise `errExists` döndür, istemci sorsun
- [x] Kopyala ve kes dallarını aynı davranışa getir

### 8. Geçersiz hash sessizce köke çözülüyor — YAPILDI

**Yer:** `decodeHash` → `handler-core.ts:93`

`decodeHash` çözemediği her girdi için boş string döndürüyor, boş string ise kök dizin anlamına geliyor. Doğrulandı:

```
"v1_Lw"       -> ""   (kök, doğru)
"bozuk-hash"  -> ""   (kök, YANLIŞ)
"v2_abc"      -> ""   (kök, YANLIŞ)
null          -> ""   (kök, YANLIŞ)
```

Sonuç: bozuk veya başka bir volume'a ait bir hash ile gelen `paste` isteği dosyaları **köke** yapıştırıyor. `upload` isteği köke yüklüyor. Hata dönmüyor. Tek karakterlik bir bozulma dosyaları yanlış klasöre gönderiyor.

- [x] Çözümlenemeyen hash için ayrı bir sinyal döndür (`null` gibi)
- [x] Çağrı yerlerinde kök ile hata durumunu ayır
- [x] Hedefi zorunlu olan komutlarda (`paste`, `upload`, `mkdir`) hata döndür

---

## P1 — Performans ve ölçek

### 9. Klasör açmak thumbnail üretiyor — YAPILDI

**Yer:** `toFileInfo` → `handler-core.ts:264`

`toFileInfo` her görsel için `ensureThumbForFile` çağırıyor ve bu fonksiyon gerçekten sharp ile yeniden boyutlandırma yapıyor. `listDirectory` bunu tüm klasör için `Promise.all` içinde koşuyor. 500 görselli bir klasörü açmak tek istekte 500 sharp işlemi demek, istek zaman aşımına uğrar.

elFinder protokolü tam da bunun için `tmb: "1"` sinyalini tanımlamış.

- [x] Listelemede sadece `"1"` dön, üretimi `cmd=tmb` handler'ına bırak. Handler zaten yazılmış durumda.
- [x] `Promise.all`'a eşzamanlılık sınırı koy, aksi halde fd tükeniyor

### 10. Bayat thumbnail

**Yer:** `handler-core.ts:183`

Thumbnail'ler yalnızca yola göre anahtarlanıyor, dosya varsa hemen dönülüyor. Aynı adla yeni içerik yüklenirse küçük resim sonsuza dek eski kalır.

- [ ] Anahtara `mtime` veya boyut kat

### 11. Öksüz thumbnail birikmesi

**Yer:** `handleRm` → `handler-core.ts:430`

Yalnızca silinen hedefin thumbnail'i siliniyor. İçinde 100 görsel olan bir klasörü silince 100 öksüz thumbnail kalıyor. Yeniden adlandırma da aynı çöpü üretiyor, çünkü hash değişiyor. `.tmb` dizini sınırsız büyüyor.

- [ ] Klasör silmede alt ağaçtaki thumbnail'leri de temizle
- [ ] Rename ve move sonrası eski thumbnail'i sil
- [ ] Periyodik GC veya TTL düşün

### 12. Her şey RAM'e alınıyor — İNDİRME TARAFI YAPILDI

**Yer:** `handleFile` → `handler-core.ts:471`, `handleUpload`

- `handleFile` dosyanın tamamını `fs.readFile` ile okuyor. 2 GB'lık bir video sunucuyu düşürür.
- Yükleme tarafında her parça `arrayBuffer()` ile belleğe alınıyor, birleştirmede de her parça tek tek tamamen okunup ekleniyor.

- [x] `Readable.toWeb` ile akış döndür
- [x] HTTP Range desteği ekle. Range olmadan video ve ses önizlemesinde ileri sarma çalışmıyor.
- [ ] Birleştirmeyi `createWriteStream` ile akışa çevir
- [ ] `maxFileSize`, `maxFiles` ve toplam kota seçenekleri ekle

> Gerçek akışlı **yükleme** bu listede yok. `req.formData()` Node runtime'da gövdenin
> tamamını zaten belleğe alıyor. Onu aşmak busboy gibi kendi multipart ayrıştırıcınızı
> bağlamak demek. Ayrı ve büyük bir iş, sonraya bırakılabilir.

### 13. Chunk çöpü temizlenmiyor

`.chunks` altında yarım kalan yüklemeler hiç silinmiyor.

- [ ] TTL ve toplama mekanizması ekle

---

## P1 — Auth ve izinler

### 14. Kimlik doğrulama kancası yok

README "yetkilendirme sizin sorumluluğunuz" diyor ama kütüphane hiçbir bağlanma noktası sunmuyor. `read`, `write`, `locked` alanları `types.ts` içinde literal `1`, `1`, `0` olarak sabitlenmiş. Salt okunur bir klasörü ifade etmek **tip düzeyinde bile** mümkün değil.

Bu, paketi üretime uygun hale getirecek tek en önemli eklenti.

- [ ] `onRequest(req)` kancası ekle
- [ ] Yol başına izin veren `permissions(path)` geri çağrısı ekle
- [ ] `types.ts` içinde `read`, `write`, `locked` alanlarını `0 | 1` yap
- [ ] Kök klasörü varsayılan olarak `locked: 1` yapmayı düşün

---

## P2 — Protokol uyumu

Uygulama ile istemciye bildirilen yetenekler birkaç yerde çelişiyor.

- [ ] **15. `handler-core.ts:247`** — `archivers` listeleri boş. elFinder arayüzü arşivleme ve çıkarma menülerini hiç göstermiyor, oysa `handleArchive` ve `handleExtract` yazılmış. `create` ve `extract` içine `application/zip` koy.
- [ ] **16. `disabled` listesi** — içinde `size` var ama `handleSize` uygulanmış.
- [ ] **17. `options` nesnesi** — yalnızca kök için üretiliyor. Alt klasör açıldığında `cwd.options` boş geliyor, arşiv menüsü alt klasörlerde de kapalı kalıyor.
- [ ] **18. `handleSize` (`handler-core.ts:616`)** — klasörlere inmiyor, sadece dizin inode boyutunu topluyor. Klasör boyutu yanlış çıkıyor.
- [ ] **19. `handleZipdl`** — zip'i kullanıcının klasörüne kalıcı yazıyor ve elFinder'ın ikinci aşama indirme çağrısını karşılamıyor. Çoklu dosya indirme çalışmıyor, üstelik klasörde artık zip bırakıyor.
- [x] **20. HTTP durum kodları** — YAPILDI, madde 5 ile birlikte. Komut hataları artık HTTP 200 gövdesinde `{ "error": ["errPerm"] }` biçiminde dönüyor. 400 ve 500 dönmek istemcide bağlantı hatası olarak ele alınıyor ve gerçek mesajı yok ediyordu. i18n kod dizileri de aynı değişiklikle geldi.
- [ ] **21. `handleSearch`** — `.tmb` ve `.chunks` klasörlerini de tarıyor. Sonuçlara thumbnail ve chunk parçaları karışıyor, `listDirectory`'deki filtre buraya uygulanmamış. Ayrıca derinlik ve sonuç sınırı yok.
- [ ] **22. `handlePaste`** — bir klasörü kendi alt klasörüne taşımayı engellemiyor.
- [ ] **23. `handleDuplicate`** — `(copy)` çakışmasını kontrol etmiyor, ikinci kopyada `errorOnExist` fırlatıyor. elFinder `file(1)`, `file(2)` bekliyor.
- [ ] **24. `handleExtract` sonucu** — `added` listesine çıktı klasöründeki **tüm** girdileri koyuyor, sadece yeni çıkanları değil. 500 dosyalı bir klasöre `makedir` olmadan açım yapılırsa istemci 500 girdi görüyor ve mükerrer satırlar oluşuyor.
- [ ] **25. `_chunkmerged` sapması** — son olmayan her chunk için `_chunkmerged` döndürülüyor. Referans PHP connector'ı bunu yalnızca tüm parçalar geldiğinde döndürüyor. Birleştirme burada son chunk'ta yapıldığı için sonuç kazara doğru çıkıyor, ama istemci gereksiz merge istekleri gönderiyor. İstemciye karşı doğrulanmalı.
- [ ] **26. Sırasız chunk yarışı** — `isLastChunk` yalnızca `start + size >= total` bakıyor. Parçalar paralel gönderildiği için en son offset'li parça diğerlerinden önce varırsa birleştirme eksik parçalarla başlıyor ve dosya kırpılıyor. Gelen parça sayısını veya toplam baytı saymak gerekiyor.
- [ ] **27. `open` içinde `tree=1` yok sayılıyor** — elFinder `cmd=open&init=1&tree=1` gönderiyor. Bu durumda connector'ın ağaç klasörlerini de `files` içinde döndürmesi bekleniyor. Sol paneldeki ağaç eksik kalabilir.
- [ ] **28. `uplMaxSize` ve `uplMaxFile`** — `open` yanıtında yok, istemci yükleme boyutunu önceden doğrulayamıyor.
- [ ] **29. `mkdir` / `mkfile` EEXIST** — var olan ad için 500 fırlatıyor, `errExists` döndürmeli.
- [ ] **30. `handleGet` sadece utf8** — ikili dosyada bozuk içerik dönüyor, `conv` parametresi desteklenmiyor.

---

## P2 — Mimari

### 31. ~~Web standartlarına taşıma~~ — REDDEDİLDİ

Öneri, çekirdeği düz `Request` ve `Response` üzerine alıp Remix, Hono ve SvelteKit'i de
desteklemekti.

**Karar: yapılmayacak.** Bu paket Next.js'e özel. Çok framework desteği kapsamı gereksiz
genişletiyor ve `NextRequest` ile `NextResponse` kullanmanın pratikte bir maliyeti yok.
Bu madde kayıt olarak duruyor, tekrar önerilmesin diye.

Tek küçük not: `NextRequest` zaten `Request`'i genişletiyor, yani test yazarken
(madde 51) düz `new Request(...)` nesneleri geçirebilirsiniz. Bunun için mimari
değişikliğe gerek yok.

### 32. Depolama soyutlaması yok

Her şey doğrudan `fs/promises` çağrısı. Yol haritasında S3 varsa, yüzey hâlâ küçükken çıkarmanın tam zamanı.

- [ ] `StorageAdapter` arayüzü tanımla
- [ ] Mevcut kodu `LocalFsAdapter` olarak taşı

### 33. sharp zorunlu bağımlılık

Yaklaşık 30 MB native ikili, bazı serverless platformlarda sorun çıkarıyor. Thumbnail'e ihtiyacı olmayan kullanıcılar için ağır bir bedel.

- [ ] `sharp` ve `adm-zip`'i `optionalDependencies` yap
- [ ] `import()` ile tembel yükle, yoksa özelliği sessizce kapat

---

## P3 — Küçük ama hızlı kazançlar

- [ ] **34.** `dim` ve `resize` komutlarını yaz. sharp zaten bağımlı, ikisi de yaklaşık 20 satır. Şu an "desteklenmiyor" diye duruyorlar.
- [ ] **35. `handler-core.ts:11`** — `sharp.cache` ayarı modül yüklenirken global değiştiriliyor. Ana uygulamanın sharp davranışını da etkiliyor. En azından belgele, mümkünse kapsamla.
- [ ] **36.** `ensureUploadDir()` her istekte üç `mkdir` çağırıyor. Sonucu bir promise'te önbellekle.
- [ ] **37.** `mkdir`, `mkfile` ve `rename` gelen adda `/` veya `\` kontrolü yapmıyor. Kök dışına çıkamıyor ama dosyayı beklenmedik klasöre taşıyabiliyor.
- [ ] **38. `.chunks` dizini `public/` altında.** Yarım kalan yüklemelerin içeriği `/uploads/.chunks/...` adresinden herkese açık. Chunk ve tmb dizinlerini servis edilen kökün dışına taşı.
- [ ] **39. `looksLikeElfinderHash`** — `/^v\d+_/` kalıbını sabit kodluyor. Özel bir `volumeId` verilirse yükleme dosya adı sezgiseli bozuluyor. `VOLUME_ID` değişkenini kullan.
- [ ] **40.** `detectMimeFromName` içindeki `.pdf` dalı ölü kod, `mime-types` zaten biliyor.
- [ ] **41.** Thumbnail ve dosya yanıtlarına `Cache-Control` ekle.

---

## P2 — Dağıtım

### 42. Varsayılan yapılandırma serverless'ta çalışmıyor

Bu README'de hiç geçmiyor ve ilk kurulumda insanları yakacak şey.

Vercel gibi platformlarda `public/` içeriği **build sırasında** CDN'e yükleniyor ve çalışma anındaki dosya sistemi hem salt okunur hem geçici. Yani varsayılan `uploadDir` olan `public/uploads` orada ne yazılabiliyor ne de servis edilebiliyor.

- [ ] README'ye "Dağıtım" bölümü ekle, desteklenen ve desteklenmeyen hedefleri yaz
- [ ] Kalıcı disk veya S3 adaptörü gerektiğini açıkça belirt

### 43. `output: "standalone"` varsayılan haliyle bozuk

Paket çökmüyor ama yüklenen dosyalar yanlış yere gidiyor ve her deploy'da siliniyor.

**Yükleme dizini build çıktısının içine düşüyor.** `context.ts:17` yolu `process.cwd()`
üzerinden kuruyor. Standalone'un ürettiği `server.js` başlarken `process.chdir(__dirname)`
çağırıyor, yani cwd `.next/standalone` oluyor ve `uploadDir` = `.next/standalone/public/uploads`.
Handler bu dizini `mkdir -p` ile kendisi yarattığı için hata alınmıyor, sorun sessiz.
Her `next build` ve her yeni Docker imajı birikeni siliyor.

**`public/` standalone'a kopyalanmıyor.** Next dokümanı birebir: "This minimal server does
not copy the `public` or `.next/static` folders by default." Elle kopyalanınca bile bu
build anındaki bir kopya, çalışma anında yazılanları kapsamıyor.

**Monorepo izleme kökü ayarlı değil.** `apps/playground/next.config.ts` yalnızca
`serverExternalPackages` içeriyor. Doküman uyarısı: monorepo'da izleme kökü proje dizini
oluyor, dışındakiler bundle'a girmiyor. `elfinder-next` `packages/` altında, yani
`apps/playground` dışında, üstelik pnpm sembolik link kullanıyor. Aynı doküman `sharp`
için de tam bu sorunu örnekliyor.

Gereken minimum:

```ts
// next.config.ts
outputFileTracingRoot: path.join(__dirname, "../../"),
outputFileTracingIncludes: { "/*": ["node_modules/sharp/**/*"] },

// route.ts
createElfinderHandler({ uploadDir: process.env.ELFINDER_DIR });  // mutlak yol, mount'lu volume
```

- [ ] README'ye standalone bölümü ekle, yukarıdaki üç ayarı da göster
- [ ] `uploadDir` verilmediğinde `process.cwd()` tahmininin riskli olduğunu belgele
- [ ] Playground'un `next.config.ts` dosyasına `outputFileTracingRoot` ekle

### 44. `publicUrl: ""` ifade edilemiyor — YAPILDI

42 ve 43'ün doğru çözümü dosyaları `public/` dışında tutup önizlemeleri `cmd=file`
üzerinden servis etmek. elFinder bunu destekliyor: `url` boş bırakılırsa istemci dosya
adreslerini connector üzerinden kuruyor.

Ama paket bunu ifade edemiyor. `context.ts:29` boş stringi `"/"` haline getiriyor
(`"".endsWith("/")` false), bu da elFinder'a "dosyalar sitenin kökünden servis ediliyor"
demek. Yani şu an standalone ve serverless için doğru yapılandırma kurulamıyor.

- [x] Boş `publicUrl` ve `tmbUrl` değerlerini olduğu gibi geçir, trailing slash ekleme
- [x] Boş olduğunda `cwd.options.url` alanını `""` olarak döndür
- [x] Aynısını `tmbUrl` için yap

### 45. Doğrulanması gereken: çalışma anında eklenen public dosyaları

Next üretim modunda `public/` dosya listesini sunucu açılışında bir kez okuyup önbelleğe
alıyor, bu yüzden çalışma anında eklenen dosyalar yeniden başlatılana kadar 404 dönüyor.
Uzun süredir bilinen bir davranış ve eski dokümanda açıkça yazıyordu, güncel sayfada
o not artık yok.

- [ ] Next 16.2 üzerinde test et: `next start`, bir dosya yükle, `/uploads/<ad>` adresine git
- [ ] Davranış sürüyorsa madde 44 P0'a çıkıyor, çünkü varsayılan kurulum önizleme gösteremiyor

---

## P3 — Depo hijyeni

Aşağıdakiler `git ls-files` ile doğrulandı.

- [x] **46. İç içe pnpm workspace.** `apps/playground/pnpm-workspace.yaml` ve `apps/playground/pnpm-lock.yaml` commit'lenmiş. Alt dizinde workspace dosyası olması pnpm'in orayı ayrı bir workspace kökü saymasına yol açıyor, bu da `elfinder-next: workspace:*` çözümlemesini bozuyor. İkisini de sil, `ignoredBuiltDependencies` ayarını kök `pnpm-workspace.yaml` içine taşı.
- [x] **47. Karışık paket yöneticisi.** Kökte hem `package-lock.json` hem `pnpm-lock.yaml` var. npm lockfile'ı neredeyse boş, sil.
- [x] **48. Build artefaktı commit'lenmiş.** `apps/playground/tsconfig.tsbuildinfo` gitignore'a girmeli.
- [x] **49. Playground kırık.** `app/page.tsx` butonu `/elfinder-static/picker.html`, iframe'i `/elfinder/picker.html` açıyor. İkisi farklı, biri kesinlikle 404.
- [ ] **50. Temiz klone playground çalışmıyor.** `.gitignore` içinde `apps/playground/public/elfinder` var, yani elFinder arayüz dosyaları depoda yok ve onları getiren bir adım veya script de yok. README "playground'u çalıştır" diyor ama çalışmıyor.
- [x] **51. Test yok.** — YAPILDI, 99 test 7 dosyada. Bir protokol connector'ı tam olarak sözleşme testi gerektiren şey. Geçici dizin ve fixture istekleriyle vitest kurmak bir günlük iş, yukarıdaki hataların çoğunu regresyona karşı kilitler.
- [x] **52. CI yok.** — YAPILDI, 3 OS x Node 20/22 artı bloke etmeyen Node 18 işi. Build, test ve lint için bir workflow ekle.
- [ ] **53. `LICENSE` dosyası yok.** README'deki rozet var olmayan bir dosyaya bağlanıyor.
- [ ] **54.** `package.json` içinde `repository`, `homepage`, `bugs` ve `engines` alanları eksik. npm sayfasında kaynak bağlantısı görünmeyecek.
- [ ] **55.** `files` dizisi `LICENSE`'ı da içermeli.
- [ ] **56.** README hâlâ `v0.1.0` diyor, paket `0.1.1`.
- [ ] **57.** Root README'deki `https://github.com/your-org/elfinder-next` placeholder'ını gerçek URL ile değiştir.
- [ ] **58. Peer aralığı doğrulanmamış.** `peerDependencies` `next >= 14` diyor ama hem devDependency hem playground `16.2.6` kullanıyor. 14 ve 15 hiç denenmemiş. Ya CI'a matris ekle ya aralığı daralt.
- [ ] **59.** CJS build eklemeyi düşün (`format: ["esm", "cjs"]`), `sideEffects: false` ekle.

### 60. Node 18 desteği iddiası muhtemelen yanlış

Test paketini kurarken çıktı, ilk iki turda yoktu.

`handler-core.ts:1216` yüklenen dosyaları süzmek için global `File` kullanıyor:

```ts
formData.getAll("upload[]").filter((f): f is File => f instanceof File)
```

`File` globali Node 20'de geldi. Node 18'de `node:buffer` üzerinden erişilebiliyor
ama global değil, yani orada bu satır istek anında `ReferenceError` atar. README
ise "Node.js 18+ (20+ recommended)" diyor.

Buradaki Node 26 olduğu için doğrudan test edilemedi. CI'a bunu cevaplatmak üzere
`node18` işi eklendi, `continue-on-error: true` ile bloke etmiyor.

- [ ] CI'daki `node18` işinin sonucuna bak
- [ ] Başarısızsa ya iddiayı Node 20+'a çek ya `File` globalinden vazgeç
- [ ] `package.json` içine `engines` alanı ekle (madde 51 ile birlikte)

---

### Kırılganlık notu

`export const { GET, POST, runtime } = createElfinderHandler()` kalıbı Next'in segment yapılandırmasını statik olarak okumasına dayanıyor. Destructuring bir fonksiyon çağrısından geldiği için Next bunu statik olarak çözemez. Bugün sorun çıkmıyor çünkü `nodejs` zaten varsayılan runtime, ama bu şansa kalmış bir durum.

- [ ] README'de `runtime`'ı ayrıca ve düz değer olarak yazmayı öner:

```ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const { GET, POST } = createElfinderHandler();
```

---

## Maliyet tahmini

Mevcut kütüphane 1111 satır, `handler-core.ts` bunun 1010'u.

| Bölüm | Yeni satır | Dokunulan satır |
|---|---|---|
| P0 güvenlik (1-6) | 150 | 40 |
| P0 veri kaybı (7-8) | 60 | 50 |
| P1 performans (9-13) | 220 | 60 |
| P1 auth ve izinler (14) | 120 | 90 |
| P2 protokol (15-30) | 210 | 90 |
| P2 tembel bağımlılık (33) | 40 | 20 |
| P3 küçük düzeltmeler (34-41) | 95 | 30 |
| P2 dağıtım (42-45) | 90 | 30 |
| P3 depo hijyeni (46-59, test hariç) | 110 | 40 |
| **Ara toplam** | **1095** | **450** |
| P2 StorageAdapter (32) | 250 | 200 |
| Test paketi (51) | 700 | 0 |
| **Genel toplam** | **2045** | **650** |

Depolama soyutlaması ve testler hariç yaklaşık 1100 satır. Hepsi dahil yaklaşık 2050 satır, kütüphane üçe katlanıyor.

Gizli maliyet: `fs.realpath` kontrolü (madde 6) `resolveWithinRoot`'u async yapıyor, bu da yaklaşık 25 çağrı yerine `await` eklemek demek. Satır sayısı artmıyor ama diff büyüyor.

### Önerilen ilk dilim

Bir hafta sonuna sığar, yaklaşık 400 satır, kütüphaneyi "güvenli değil" durumundan çıkarır:

- Maddeler 1-8 (tüm P0)
- Madde 9 (tembel thumbnail)
- Madde 12'nin sadece indirme tarafı
- Madde 44 (`publicUrl: ""` desteği, standalone'u açar)
- Maddeler 46-49 (depoyu çalışır hale getir)
