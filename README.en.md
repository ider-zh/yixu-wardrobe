# Yixu Wardrobe · 衣序

Dress an ordinary moment in something you love.

Yixu is a wardrobe to wander through at your own pace. Starting with 100 complete looks, its expressive photography brings movement, emotion and smiles to everyday styling.

[Explore online](https://www.8882088.xyz/) · [简体中文](README.md) · [Repository](https://github.com/ider-zh/yixu-wardrobe)

## Take your time choosing

- **Start with the latest issue.** The homepage features the newest published outfit, followed by recent additions. Dates come from publication records; historical outfits are not assigned invented dates.
- **Browse your way.** In 全部穿搭 (All looks), filter by style, season, model or region. Newest publications appear first, with curated exploration available as an alternative.
- **Follow a model.** The 模特 (Models) page shows each model's published outfits. Historical photographs are not assigned to a newly registered model without checking their identity.
- **Find a favorite.** Search names, numbers, garments, materials or moods. The gallery labels are Chinese: try 丝绒 for velvet, 百褶裙 for pleated skirts or 惊喜 for surprise.
- **Look closer.** Select 01–09 by shot number and name to explore the expression, movement and framing, then read the garment list and styling notes.
- **Follow an idea.** Linked tags in outfit details search the wardrobe for related outfits. Your browser's Back button returns to the outfit you were viewing.
- **Explore each piece.** Browse independent designs across Chinese-inspired, streetwear, resort and daily edits. Explore complete forms, angles and details, return to the original outfit photograph for wearing context, and save pieces separately. Design additions unsupported by the original photograph are disclosed as extrapolations.
- **Site themes.** The site offers 12 layouts and visual styles, including Editorial, Studio, Contact Sheet, Linen Room, and Night Runway. Administrators set the theme for the site in the 网站主题 section of the workspace. The storefront retrieves the current theme when visitors open or return to the page, preserving their favorites and browsing context.
- **Keep a look.** Save favorites with the heart, compare two or three outfits, or choose 保存图片 to download. Existing numbers and favorites stay associated with their outfits.

Keyboard shortcuts: `/` for search, `←` and `→` for adjacent looks in details, and `Esc` to close a dialog.

The public interface shows only 生动 · Expressive. Historical 造型 · Styling photographs and metadata remain archived in the project and are excluded from the public build and browsing controls.

## Start browsing

Visit the [Yixu online wardrobe](https://www.8882088.xyz/) to browse, filter and save looks. Source updates and live deployments are separate; deployment determines which features are available online.

The frontend reads updates from the resource interface. Until a CDN is configured and each image is verified, it uses project WebP images. Verified CDN images are preferred, with project images retained as a loading fallback.

For offline browsing, copy the complete built `public/` folder and open its `index.html`. No browser extension or account is required. Keep the folder structure intact; see [Development notes](DEVELOPMENT.md) for building the offline package. Opening the source root's `index.html` directly still shows the frozen initial wardrobe snapshot.

The 200 historical photographs are same-dimension WebP totaling 48,176,224 bytes (about 48.18 MB). The public build packages displayable images declared by the content manifests. Display names and five-view references for future outfit creation are recorded in the [model registry](content/models.json).

## Favorites and photos

Outfit and product favorites are stored separately in the current browser; favorite selections are not uploaded. Switching browsers or addresses, or clearing browser data, may remove or separate them.

Online page visits use a local IP database to estimate the country and, for China, province. Only administrators can view these statistics. Raw IP addresses are not stored or sent to a third-party lookup service. Results describe approximate network exits, may reflect proxies or carrier/database errors, and do not establish a person's location. Anonymous browser counts are not people counts; missing historical locations remain unknown.

Open My Try-ons to manage photos and history in your current browser. Photos taken with the camera or selected from your library are saved in this site's browser storage. You can reuse or delete them there. Choose a clear original photo of one person with their face, head and shoes visible. Select a reference shot and accept the disclosed use before submitting the photo. My Try-ons shows processing progress and finished images. You can still view and download results saved in the same browser. Clearing site data removes those local copies. Online generation requires an available backend and generation service, and administrators may assess generated images during development. User photos, private try-on results and credentials use private storage.

Choose a single try-on that preserves the original pose, or a nine-cell grid. The grid puts the entire original photo in the center and shows the same outfit in eight poses around it. The center photo is stored with the private result and is masked in the administrator preview.

Character and outfit images are generative artwork for styling inspiration and visual enjoyment. Details may vary; images do not establish actual size or fit.

The main website uses HTTPS and displays ICP filing number [浙ICP备2026098002号](https://beian.miit.gov.cn/).

For maintenance or content production by an external agent, see [Development notes](DEVELOPMENT.md), the [outfit production SOP](docs/external-agent-sop.md) and the [product image SOP](docs/product-agent-sop.md).
