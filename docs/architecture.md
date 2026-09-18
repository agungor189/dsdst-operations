# DSDST Operations v1 architecture

The applications remain independent repositories and independently buildable images. This repository owns only deployment composition, operational scripts, and system-level tests.

## Runtime topology

| Service | Public host port | Networks | Persistent state |
| --- | ---: | --- | --- |
| `dsdst-panel` | `3000` | edge, internal | Panel DB, uploads, backups |
| `dsdst-warehouse` | `3006` | edge, internal | none |
| `dsdst-kit-studio` | `3012` | edge, internal | Kit DB and uploads |
| `dsdst-customer-hub` | `3100` | edge, internal | Hub DB and attachments |
| `label-printer` | `3013` | edge, internal | shared template state |
| `warehouse-label-renderer` | none | internal only | label state, read-only |

`dsdst-internal` is an internal Docker network. The renderer has neither a host port nor an edge-network attachment. Warehouse and Panel call it at `http://warehouse-label-renderer:3010` with `LABEL_RENDERER_API_KEY`.

The Panel remains the sole owner of the product, stock, user, finance, order, and warehouse databases. Warehouse, Kit Studio, and Customer Hub reach those contracts through Panel APIs; none mounts or opens the Panel database. Customer Hub owns channel accounts, contacts, conversations, messages, outbox jobs, and attachments. Label-Printer remains the owner of template design and rendering.

The edge network is not a replacement for a reverse proxy. Public services bind to `127.0.0.1` by default and should be published through the existing TLS proxy or tunnel.
