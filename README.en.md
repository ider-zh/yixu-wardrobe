# Yixu Wardrobe · 衣序

Dress an ordinary moment in something you love.

Yixu is a wardrobe to wander through at your own pace. Starting with 100 complete looks, its expressive photography brings movement, emotion and smiles to everyday styling.

[Explore online](https://www.8882088.xyz/) · [简体中文](README.md) · [Repository](https://github.com/ider-zh/yixu-wardrobe)

## Take your time choosing

- **Start with the latest issue.** The homepage features the newest published outfit, followed by recent additions. Dates come from publication records; historical outfits are not assigned invented dates.
- **Browse your way.** In 全部穿搭 (All looks), filter by style, season, model or region. Newest publications appear first, with curated exploration available as an alternative.
- **Follow a model.** The 模特 (Models) page shows each model's published outfits. Historical photographs are not assigned to a newly registered model without checking their identity.
- **Find a favorite.** Search names, numbers, garments, materials or moods. The gallery labels are Chinese: try 丝绒 for velvet, 百褶裙 for pleated skirts or 惊喜 for surprise.
- **Look closer.** Open an outfit's expressive nine-photo grid. Select 01–09 to explore one moment, then read the garment list and styling notes.
- **Keep a look.** Save favorites with the heart, compare two or three outfits, or choose 保存图片 to download. Existing numbers and favorites stay associated with their outfits.

Keyboard shortcuts: `/` for search, `←` and `→` for adjacent looks in details, and `Esc` to close a dialog.

The public interface shows only 生动 · Expressive. Historical 造型 · Styling photographs and metadata remain archived in the project and are excluded from the public build and browsing controls.

## Start browsing

Visit the [Yixu online wardrobe](https://www.8882088.xyz/) to browse, filter and save looks. Source updates and live deployments are separate; deployment determines which features are available online.

The frontend reads updates from the resource interface. Until a CDN is configured and each image is verified, it uses project WebP images. Verified CDN images are preferred, with project images retained as a loading fallback.

For offline browsing, copy the complete built `public/` folder and open its `index.html`. No browser extension or account is required. Keep the folder structure intact; see [Development notes](DEVELOPMENT.md) for building the offline package. Opening the source root's `index.html` directly still shows the frozen initial wardrobe snapshot.

The 200 historical photographs are same-dimension WebP totaling 48,176,224 bytes (about 48.18 MB). The public build packages only displayable images declared by the content manifests, excluding archived styling photographs. A [five-view female model base](assets/model-bases/female-01.webp) provides the reference for future outfit creation with system model 01.

## Favorites and photos

Favorites remain in the current browser; favorite selections are not uploaded. Switching browsers or addresses, or clearing browser data, may remove or separate them.

Online photo try-on requires an available backend and generation service. A photo is uploaded only after selecting a reference and explicitly accepting its disclosed use. Results are available to their owner through the existing browser credential; administrators may assess generated results during development. User photos, private try-on results and credentials never enter public image hosting or project source. Offline browsing does not provide online try-on.

Character and outfit images are generative artwork for styling inspiration and visual enjoyment. Details may vary; images do not establish actual size or fit.

The main website uses HTTPS and displays ICP filing number [浙ICP备2026098002号](https://beian.miit.gov.cn/).

For maintenance or daily outfit production by an external agent, see [Development notes](DEVELOPMENT.md) and the [content production SOP](docs/external-agent-sop.md).
