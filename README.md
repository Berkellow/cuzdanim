# Cüzdanım

Tarayıcıda çalışan, Modern Dark Fintech tasarımlı kişisel finans uygulaması. Dashboard, işlemler, abonelikler, bütçeler, raporlar ve ayarlar aynı uygulama içinde çalışır. Veriler bu tarayıcının IndexedDB alanında saklanır.

## Proje yapısı

- `index.html` — uygulama arayüzü ve mobil/masaüstü navigasyonu
- `styles.css` — tema, bileşenler ve responsive düzen
- `app.js` — ekran davranışları, modül bağlantıları ve uygulama içi bildirimler
- `js/database.js` — IndexedDB v4 şeması, migration ve veri API'leri
- `js/money.js` — kuruş bazlı TL dönüştürme ve biçimlendirme
- `js/dashboard-data.js` — dashboard özetleri ve grafik verileri
- `js/budget-data.js` — aylık bütçe hesaplamaları
- `js/reports-data.js` — rapor tarih aralıkları ve özet hesaplamaları
- `js/data-backup.js` — JSON yedek doğrulama ve biçimleme
- `assets/images/cuzdanim-logo.svg` — uygulama logosu
- `tests/indexeddb.test.html` ve `tests/indexeddb.test.js` — gerçek tarayıcı IndexedDB test koşucusu ve senaryoları

## Çalıştırma

Proje klasörünü VS Code Live Server ile açıp `index.html` sayfasını çalıştırın. ES modülleri ve IndexedDB nedeniyle sayfayı `file://` üzerinden açmayın. Projede paket yöneticisi, derleme adımı veya ek JavaScript kütüphanesi yoktur.

## Veri ve yedekler

- Veritabanı adı: `CuzdanimDB`
- Veritabanı sürümü: `4`
- Depolar: `transactions`, `categories`, `subscriptions`, `subscriptionPayments`, `budgets`
- Para değerleri tam sayı kuruş olarak tutulur ve uygulamada Türk lirası (₺) biçiminde gösterilir.
- JSON yedeği ve geri yükleme Ayarlar ekranından yapılır.

Bildirim paneli yaklaşan abonelik ödemeleriyle bütçe uyarılarını uygulama verilerinden üretir. Okundu durumu bu tarayıcıda saklanır; tarayıcı kapalıyken çalışan arka plan veya sistem bildirimi yoktur.

## Testler

Testleri çalıştırmak için Live Server üzerinden `tests/indexeddb.test.html` sayfasını açın. Migration senaryoları benzersiz fixture veritabanları kullanır. CRUD ve form senaryoları test tarayıcısındaki `CuzdanimDB` içinde geçici test kayıtları oluşturup temizler; bu yüzden testleri gerçek kullanıcı verisi bulunmayan ayrı bir tarayıcı profiliyle çalıştırın.
