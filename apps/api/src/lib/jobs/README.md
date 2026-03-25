# Jobs!!!

"Ok why does this dir have 3 files that all start with "Job"... what is happening here?".

That's probably what your thinking. Let me explain;

## JobQueue

This is the entry point. The API registers new jobs with the queue. The queue is responsible for executing multiple jobs in parallel and re-loading jobs into the queue when the app restarts. This means it does interact with the database minimally - it simply reads pending jobs and reloads them into memory.

## Job Handler
This class can be thought of like the "Job Manager". It gathers the initial information about the job and hands it to the first function in the pipeline (we'll come back to this). It also exposes functions for logging which can and are by the job functionality itself, this allows us to group logs by job and not flood the terminal.

## Jobline (pipeline)
The Job-Pipeline is the class that defines all segments of this job and runs each one. Technically the pipeline class that is used doesn't actually provide any job specific support, it's more of a helper to pass all arguments in and update the status.
