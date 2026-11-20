"""Local coarse IP lookup. Never persist addresses or query a remote provider."""

import ipaddress
import logging
import re
import threading
from pathlib import Path
from typing import Any

import maxminddb

log = logging.getLogger(__name__)

# Translate province names supplied by the database; never infer from a city.
PROVINCES = dict(
    zip(
        [
            "Beijing",
            "Tianjin",
            "Hebei",
            "Shanxi",
            "Inner Mongolia",
            "Liaoning",
            "Jilin",
            "Heilongjiang",
            "Shanghai",
            "Jiangsu",
            "Zhejiang",
            "Anhui",
            "Fujian",
            "Jiangxi",
            "Shandong",
            "Henan",
            "Hubei",
            "Hunan",
            "Guangdong",
            "Guangxi",
            "Hainan",
            "Chongqing",
            "Sichuan",
            "Guizhou",
            "Yunnan",
            "Tibet",
            "Shaanxi",
            "Gansu",
            "Qinghai",
            "Ningxia",
            "Xinjiang",
        ],
        [
            "北京市",
            "天津市",
            "河北省",
            "山西省",
            "内蒙古自治区",
            "辽宁省",
            "吉林省",
            "黑龙江省",
            "上海市",
            "江苏省",
            "浙江省",
            "安徽省",
            "福建省",
            "江西省",
            "山东省",
            "河南省",
            "湖北省",
            "湖南省",
            "广东省",
            "广西壮族自治区",
            "海南省",
            "重庆市",
            "四川省",
            "贵州省",
            "云南省",
            "西藏自治区",
            "陕西省",
            "甘肃省",
            "青海省",
            "宁夏回族自治区",
            "新疆维吾尔自治区",
        ],
        strict=True,
    )
)


def name(record):
    names = record.get("names") or {}
    value = names.get("zh-CN") or names.get("en")
    return value[:100] if isinstance(value, str) and value.strip() else None


class GeoLocator:
    source = "DB-IP City Lite"

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.reader: Any = None
        self.signature: tuple[int, int, int] | None = None
        self.status = "unconfigured"
        self.build: int | None = None

    def _refresh(self):
        try:
            stat = self.path.stat()
            signature = (stat.st_mtime_ns, stat.st_size, stat.st_ino)
        except OSError:
            self.close()
            self.signature = None
            self.status = "unconfigured"
            return
        if signature == self.signature:
            return
        self.close()
        self.signature = signature
        try:
            self.reader = maxminddb.open_database(str(self.path))
            self.build = self.reader.metadata().build_epoch
            self.status = "ready"
        except (
            OSError,
            ValueError,
            TypeError,
            AttributeError,
            KeyError,
            IndexError,
            maxminddb.InvalidDatabaseError,
        ):
            self.close()
            self.status = "unavailable"
            log.warning("Offline geolocation database cannot be opened")

    def close(self):
        with self.lock:
            if self.reader:
                self.reader.close()
            self.reader = None
            self.build = None
            self.signature = None

    def info(self):
        with self.lock:
            self._refresh()
            return {"status": self.status, "source": self.source, "build_epoch": self.build}

    def lookup(self, host):
        result: dict[str, Any] = {
            "country_code": None,
            "country_name": None,
            "region_code": None,
            "region_name": None,
            "status": "unknown",
            "source": self.source,
            "database_build": None,
        }
        try:
            address = ipaddress.ip_address(host)
        except (ValueError, TypeError):
            return result
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        if not address.is_global:
            return {**result, "status": "private"}
        with self.lock:
            self._refresh()
            result["database_build"] = self.build
            if self.reader is None:
                return {**result, "status": "unavailable"}
            try:
                record = self.reader.get(str(address)) or {}
                country = record.get("country") or {}
                code = country.get("iso_code")
                if not isinstance(code, str) or not re.fullmatch(r"[A-Z]{2}", code):
                    return result
                result.update(country_code=code, country_name=name(country), status="located")
                if code == "CN":
                    result["country_name"] = "中国"
                    regions = record.get("subdivisions") or []
                    region = regions[0] if regions else {}
                    region_name = name(region)
                    result["region_name"] = PROVINCES.get(region_name, region_name)
                    region_code = region.get("iso_code")
                    if isinstance(region_code, str) and re.fullmatch(
                        r"[A-Za-z0-9-]{1,24}", region_code
                    ):
                        result["region_code"] = region_code
                return result
            except (
                OSError,
                ValueError,
                TypeError,
                AttributeError,
                KeyError,
                IndexError,
                maxminddb.InvalidDatabaseError,
            ):
                # Lookup failure must not prevent analytics or leak the address in logs.
                return {
                    **result,
                    "status": "unavailable",
                    "country_code": None,
                    "country_name": None,
                    "region_code": None,
                    "region_name": None,
                }
