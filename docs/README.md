# Deploying the garbage-collector

The `garbage-collector` is the component which handles pulling records for
deleted objects from the metadata tier, and sending instructions to storage
zones to delete the unneeded objects.

## Get the Latest Image

To deploy garbage-collector you'll probably first want to get the latest
`garbage-collector` image. To do so you can run:

```
GARBAGE_IMAGE=$(updates-imgadm list name=mantav2-garbage-collector --latest -H -o uuid)
sdc-imgadm import -S https://updates.joyent.com ${GARBAGE_IMAGE}
```

if this returns an error that the image already exists, you already have the
latest image.

## Configuration: Option A

Once you've got the latest image installed in your DC, you can generate a config
using:

```
manta-adm gc genconfig ${GARBAGE_IMAGE} ${NUM_COLLECTORS} > gc-config.json
```

where `${NUM_COLLECTORS}` is the number of collectors you want to have. This
should be a number less than or equal to the number of shards you have and the
number of shards each garbage collector will need to collect from will be:

```
NUM_SHARDS / NUM_COLLECTORS
```

So if you have 50 shards and want each collector to collect for 10 shards,
you'd run:

```
manta-adm gc genconfig ${GARBAGE_IMAGE} 5 > gc-config.json
```

to generate a config with 5 `garbage-collector` zones.

If you get the error:

```
no CNs meet deployment criteria
```

this means you do not have enough CNs that:

 * do not have a `storage` zone
 * do not have a `nameservice` zone
 * do not have a `loadbalancer` zone

You need to have at least `${NUM_COLLECTORS}` nodes that match these criteria in
order to generate a config. If you do not have these in your deployment, you can
manually place the `garbage-collectors` as you would other Manta services. See
`Configuration: Option B` section below for details.

If you've completed this successfully, you can move on to the `Provisioning the
Zones` section below.

## Configuration: Option B

If you do not have enough servers for automatic configuration, or would just
like to manually select servers for `garbage-collector` instances, you should
run:

```
manta-adm show -sj > gc-config.json
```

and then manually add a section like:

```
        "garbage-collector": {
            "acc104a2-db81-4b96-b962-9b51409eadc0": 1
        },
```

to the `gc-config.json` file for each server onto which you'd like to provision
a `garbage-collector` zone. At this point you're ready to move on to the section
below.

## Provisioning the Zones

Once you've created a `gc-config.json` config file either manually or using the
generator, you are ready to start creating the `garbage-collector` zones. To do
so, run:

```
manta-adm update gc-config.json
```

A full run might look like:

```
[root@headnode (nightly-2) ~]# manta-adm update gc-config.json
logs at /var/log/manta-adm.log
service "garbage-collector"
  cn "00000000-0000-0000-0000-002590c0933c":
    provision (image acc104a2-db81-4b96-b962-9b51409eadc0)
  cn "cc9ad6da-e05e-11e2-8e23-002590c3f078":
    provision (image acc104a2-db81-4b96-b962-9b51409eadc0)
Are you sure you want to proceed? (y/N): y

service "garbage-collector": provisioning
    server_uuid: 00000000-0000-0000-0000-002590c0933c
     image_uuid: acc104a2-db81-4b96-b962-9b51409eadc0
service "garbage-collector": provisioning
    server_uuid: cc9ad6da-e05e-11e2-8e23-002590c3f078
     image_uuid: acc104a2-db81-4b96-b962-9b51409eadc0
service "garbage-collector": provisioned aefbf103-b815-4f95-84ea-e446c4e9bb50
    server_uuid: 00000000-0000-0000-0000-002590c0933c
     image_uuid: acc104a2-db81-4b96-b962-9b51409eadc0
service "garbage-collector": provisioned a1f48ab2-6c8a-4538-8567-2ca74a9d5b4d
    server_uuid: cc9ad6da-e05e-11e2-8e23-002590c3f078
     image_uuid: acc104a2-db81-4b96-b962-9b51409eadc0
[root@headnode (nightly-2) ~]#
```

At this point you should have `garbage-collector` instances but they will not
yet be collecting any garbage. To have them start doing that, proceed to the
next step.

## Configuring garbage-collectors

There are 2 parts to updating the `garbage-collector` shard assignments. First
you want to generate an assignment:

```
manta-adm gc gen-shard-assignment > gc-shard-assignment.json
```

you can take a look at this if you'd like to make sure it looks reasonable. It
should look something like:

```
{
    "aefbf103-b815-4f95-84ea-e446c4e9bb50": {
        "GC_ASSIGNED_BUCKETS_SHARDS": [
            {
                "host": "1.buckets-mdapi.nightly.joyent.us",
                "last": true
            }
        ],
        "GC_ASSIGNED_SHARDS": [
            {
                "host": "1.moray.nightly.joyent.us",
                "last": true
            }
        ]
    },
    "a1f48ab2-6c8a-4538-8567-2ca74a9d5b4d": {
        "GC_ASSIGNED_BUCKETS_SHARDS": [
            {
                "host": "2.buckets-mdapi.nightly.joyent.us",
                "last": true
            }
        ],
        "GC_ASSIGNED_SHARDS": [
            {
                "host": "2.moray.nightly.joyent.us",
                "last": true
            }
        ]
    }
}
```

which will mean that the first `garbage-collector` is responsible for the shards
`1.buckets-mdapi` and `1.moray` and the second `garbage-collector` is
responsible for the shards `2.buckets-mdapi` and `2.moray`. If this looks fine,
you can apply the configuration by running:

```
manta-adm gc update gc-shard-assignment.json
```

which will apply the SAPI metadata changes in order to make the new
configuration active. You should be able to confirm this by running:

```
manta-oneach -s garbage-collector "json dir_shards buckets_shards < /opt/smartdc/manta-garbage-collector/etc/config.json
```

At this point garbage collection should be working for all deleted objects in
both buckets and directory-style Manta.
