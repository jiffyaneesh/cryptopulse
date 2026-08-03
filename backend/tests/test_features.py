import math
import pytest
from app.scoring.features import FeatureExtractor

def test_feature_extractor_returns_none_on_first_call():
    extractor = FeatureExtractor(window_size=3)
    assert extractor.extract(100.0, 1000.0) is None

def test_feature_extractor_returns_valid_features_after_warmup():
    extractor = FeatureExtractor(window_size=3)
    # Tick 1: price=100 (sets prev_price) -> returns None
    assert extractor.extract(100.0, 1000.0) is None
    # Tick 2: returns len=1 -> returns None
    assert extractor.extract(101.0, 1100.0) is None
    # Tick 3: returns len=2 -> returns None
    assert extractor.extract(102.0, 1200.0) is None
    
    # Tick 4: returns len=3, now warmed up -> returns dict
    features = extractor.extract(103.0, 1300.0)
    assert features is not None
    assert "ret" in features
    assert "vol" in features
    assert "z_ret" in features
    assert "vol_delta" in features

def test_log_return_computation():
    extractor = FeatureExtractor(window_size=2)
    extractor.extract(100.0, 1000.0)
    extractor.extract(110.0, 1100.0)
    features = extractor.extract(121.0, 1210.0)
    
    assert features is not None
    expected_ret = math.log(121.0 / 110.0)
    assert math.isclose(features["ret"], expected_ret)

def test_vol_delta_uses_volume():
    extractor = FeatureExtractor(window_size=2)
    extractor.extract(100.0, 1000.0)
    extractor.extract(110.0, 2000.0)
    features = extractor.extract(121.0, 4000.0)
    
    assert features is not None
    # The rolling mean of volume window before appending 4000 was (1000, 2000), but extract appends BEFORE computing features
    # Wait, the code appends before checking is_warmed_up.
    # In tick 1: volume_window=[1000]
    # In tick 2: volume_window=[1000, 2000]
    # In tick 3: volume_window=[2000, 4000] (maxlen=2 evicts 1000)
    # mean_vol = (2000 + 4000) / 2 = 3000
    expected_vol_delta = math.log(4000.0 / 3000.0)
    assert math.isclose(features["vol_delta"], expected_vol_delta)

def test_z_ret_is_ret_divided_by_vol():
    extractor = FeatureExtractor(window_size=2)
    extractor.extract(100.0, 1000.0)
    extractor.extract(110.0, 1100.0)
    features = extractor.extract(121.0, 1210.0)
    
    assert features is not None
    assert math.isclose(features["z_ret"], features["ret"] / features["vol"])
