"""Compact sample bill (seed 42) for the website: per-series daily cost and quantity arrays."""
import json, pandas as pd
df = pd.read_csv('data/focus_billing.csv')
df['date'] = df.ChargePeriodStart.str[:10]
u = df[df.ChargeCategory == 'Usage']
days = sorted(df.date.unique())
series = []
for key, g in u.groupby(['SubAccountName', 'ServiceName', 'RegionId', 'x_UsageType']):
    g = g.set_index('date').reindex(days)
    tags = json.loads(g.Tags.dropna().iloc[0])
    series.append({'a': key[0], 's': key[1], 'r': key[2], 'u': key[3], 't': tags.get('team', ''), 'unit': g.PricingUnit.dropna().iloc[0],
                   'c': [round(x, 2) for x in g.EffectiveCost.fillna(0)], 'q': [round(x, 3) for x in g.PricingQuantity.fillna(0)]})
other = df[df.ChargeCategory != 'Usage']
out = {'name': 'Northwind sample bill (synthetic)', 'currency': 'USD', 'start': days[0], 'n': len(days), 'series': series,
       'other': round(float(other.EffectiveCost.sum()), 2), 'rows': len(df),
       'events': [{'name': e['name'], 'start': e['start'], 'end': e['end'], 'account': 'prod-retail' if e['id'] == 'E1' else 'data-platform',
                   'service': '' if e['id'] == 'E1' else 'Amazon Redshift'} for e in json.load(open('data/known_events.json'))],
       'truth': [{k: t[k] for k in ('id', 'title', 'start', 'end', 'account', 'service', 'region', 'usage_type', 'true_cause')} for t in json.load(open('data/ground_truth.json'))]}
s = json.dumps(out, separators=(',', ':'))
open('web/sample.json', 'w').write(s)
print(len(series), len(days), len(s) // 1024, 'KB')
