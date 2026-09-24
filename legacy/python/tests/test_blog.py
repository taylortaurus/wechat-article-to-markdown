"""Blog 来源的离线单元测试（不依赖网络）。"""
from bs4 import BeautifulSoup

from spider_claw.sources.blog import (
    BLOG_SITES,
    BlogSource,
    _parse_date,
    discover_from_sitemap,
)

SRC = BlogSource()


def test_match_only_known_domains():
    assert SRC.match("https://addyosmani.com/blog/foo/")
    assert SRC.match("https://www.addyosmani.com/blog/foo/")
    assert not SRC.match("https://example.com/post")


def test_article_id_strips_query_and_anchor():
    aid = SRC.article_id("https://addyosmani.com/blog/foo/?x=1#bar")
    assert aid == "/blog/foo"


def test_normalize_preserves_query_strips_fragment():
    # normalize 保留 query（WordPress ?p=123 等需要），但去除 fragment
    n = SRC.normalize("https://addyosmani.com/blog/foo/?a=1#b")
    assert n == "https://addyosmani.com/blog/foo?a=1"


def test_parse_date_variants():
    assert _parse_date("July 6, 2026").startswith("2026-07-06")
    assert _parse_date("2026-07-06").startswith("2026-07-06")
    assert _parse_date("not a date") == "not a date"


_SITEMAP = """<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://addyosmani.com/blog/a/</loc></url>
<url><loc>https://addyosmani.com/notes/x/</loc></url>
<url><loc>https://addyosmani.com/blog/b/</loc></url>
</urlset>"""


def test_discover_from_sitemap_filters_blog(monkeypatch):
    import spider_claw.sources.blog as bmod

    monkeypatch.setattr(bmod, "_http_get", lambda u, referer=None, timeout=20: _SITEMAP)
    urls = discover_from_sitemap(
        "https://addyosmani.com/sitemap.xml", path_prefix="/blog/"
    )
    assert urls == [
        "https://addyosmani.com/blog/a/",
        "https://addyosmani.com/blog/b/",
    ]


def test_extract_metadata_and_date_h2():
    html = """<html><head>
    <meta property="og:title" content="The Agent-Era Career">
    <meta name="author" content="Addy Osmani">
    </head><body>
    <article class="post">
      <h1>The Agent-Era Career</h1>
      <h2>July 6, 2026</h2>
      <p>Hello world.</p>
      <script>bad()</script>
    </article></body></html>"""
    soup = BeautifulSoup(html, "html.parser")
    cfg = BLOG_SITES["addyosmani.com"]
    content, meta, imgs = SRC._extract(soup, cfg, "https://addyosmani.com/blog/x/")

    assert meta["title"] == "The Agent-Era Career"
    assert meta["author"] == "Addy Osmani"
    assert meta["publish_time"].startswith("2026-07-06")
    assert "Hello world." in content
    assert "July 6, 2026" not in content  # 日期 h2 已移除
    assert "<script" not in content  # 噪声已移除
    assert "<h1" not in content  # 与标题重复的 h1 已移除
    assert imgs == []
