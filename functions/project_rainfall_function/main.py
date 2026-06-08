def handler(context, basicio):
    basicio.write('Hello from main.py')
    basicio.get_argument('name')

    context.log('Successfully executed basicio function')
    context.close()
