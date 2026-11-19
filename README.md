# GeoSandbox

GeoSandbox 是一个面向空间数据与三维模型的 WebGIS 工作台，可以在同一个项目里导入地理数据、放置模型、预览组合方案，再导出场景或数据。

**[在线体验](https://geosandbox.top/)** · [使用说明](GeoSandbox使用说明.md) · [首版验收](docs/geosandbox/首版验收.md)

打开在线展示，选择底部「模型」里的「加载示例」，即可体验二维地图、三维场景和模型定位。可通过「数据」导入示例 GeoJSON，或通过「交付」下载并重新打开 `.geosandbox` 项目包。展示版免登录，项目的操作和保存发生在浏览器中。

## 项目功能

- **导入与检查** — 识别 GLB/glTF、GeoJSON、KML、常见 Shapefile ZIP、GeoPackage 和 GeoTIFF。使用格式、坐标参考系和源单位检查辅助定位。
- **空间装配** — 在地图上放置和复制模型实例，校准尺寸与方向，分组管理，预览轮廓对齐或带检查点的配准方案。已提交的变换支持撤销和重做。
- **交付与恢复** — 生成可携带资源的项目包，导出装配 GLB 或矢量成果。自托管版支持服务端项目存储、恢复检查点和原生 GIS 后台任务。
- **AI 辅助** — 自托管版可配置 DeepSeek 生成编辑预览，操作者确认后应用。

## 从源码运行

### Windows 完整版

需要 Node.js 22 或以上和 Python 3.10 或以上。在仓库根目录打开 PowerShell：

```powershell
git clone https://github.com/BerryBlueGel/GeoSandbox.git
cd GeoSandbox
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\geosandbox-setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\geosandbox-start.ps1 -OpenBrowser
```

首次安装包括 npm 与 Python 依赖、示例生成和前端构建。启动后访问 [本机工作台](http://127.0.0.1:5173/)。服务默认监听本机。AI 功能需要在自托管环境配置自己的 API Key。

Linux 使用 [Docker 部署说明](docs/geosandbox/单用户服务器部署.md)，其中列出了环境变量、持久化目录和 HTTPS 代理要求。

## 源码入口

| 目录 | 内容 |
| --- | --- |
| [apps/geolibre-desktop](apps/geolibre-desktop) | React 工作台、地图界面和空间装配交互 |
| [backend/geolibre_server](backend/geolibre_server) | Python 服务、原生 GIS 任务、项目存储和恢复 |
| [tests](tests) 与 [examples](examples) | 格式与工作流测试、自建几何模型及可重开的示例项目 |
| [docs/geosandbox](docs/geosandbox) | 复用决策、验收范围、公开测试数据的来源和复现方法 |

Windows 上完整安装后可运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\geosandbox-accept.ps1 -Build`，核验 GeoSandbox 前后端测试、固定样例和生产构建。

## 来源与许可

GeoSandbox 基于 [GeoLibre 3.8.0](https://github.com/opengeos/GeoLibre/tree/c0f5513930a4675c503e696ae66a475dfca6fb39)，复用其地图引擎、图层状态、空间处理和历史机制，在此基础上开发空间装配、配准、项目包和交付流程。上游说明见 [README.GeoLibre.md](README.GeoLibre.md)，复用及新增模块见 [复用决策](docs/geosandbox/REUSE.md)。源码按 [MIT 许可证](LICENSE) 发布，保留原项目版权声明。
