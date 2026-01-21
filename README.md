# tracker

## トラッキング機能
```
https://example.com/page1
トラッキングされる
```
### gh_void
```
https://example.com/page1?gh_void=0
→ アクセス解析は記録しない、ABテストを記録しない

https://example.com/page1?gh_void=1
→ アクセス解析は記録しない、ABテストは行わず、記録もしない
```

### gh_id, gh_creative
```
https://example.com/page1?gh_id=[String]&gh_creative=[num]
→ Stringとnumで指定したABテストのクリエイティブを実行する、アクセス解析とABテストを記録する
```

### gh_void + gh_id, gh_creative
```
https://example.com/page1?gh_void=[num]&gh_id=[String]&gh_creative=[num]
→ Stringとnumで指定したABテストのクリエイティブを実行する、アクセス解析とABテストを記録しない
```

## デバック機能
```
https://example.com/page1?tracker_debug=1
→ コンソールにデバック情報を出力
```

## イベントトラッキング
trackerEvent()関数で記録
```
trackerEvent('***');
<button onclick="trackerEvent('***')"></button>
```